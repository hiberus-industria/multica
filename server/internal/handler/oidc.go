package handler

// HIBERUS: fork feature — generic OIDC SSO login, modeled on GoogleLogin but
// configured entirely through OIDC_* env vars so any standards-compliant
// provider (Keycloak, Okta, Entra ID, ...) works without code changes.
//
// Flow: the web login button sends the browser to GET /auth/oidc/start, which
// discovers the provider endpoints from the issuer's well-known document,
// generates the PKCE pair server-side, and binds {verifier, state} to a
// short-lived HttpOnly flow cookie before redirecting to the provider. The
// provider returns to the existing /auth/callback route; the callback page
// POSTs {code, state, redirect_uri} here, and the handler validates the state
// against the flow cookie, exchanges the code, and issues the same JWT
// session every other login path produces.
//
// Trust boundary: the provider realm decides who exists, so OIDC logins skip
// the email allowlist (checkSignupAllowed) that gates the OTP/Google paths.
// ALLOWED_EMAILS keeps its break-glass role — those emails can still use the
// OTP path while SSO is active (see sso_gate.go).

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/logger"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Machine-readable error codes for the OIDC login path. Reuses
// googleLoginCodeAccountDisabled (same semantic, same client translation) and
// googleLoginCodeInvalidOAuthCode's value so existing client handling covers
// the shared failure shape.
const (
	oidcCodeAccountNoEmail   = "oidc_account_no_email"
	oidcCodeEmailNotVerified = "oidc_email_not_verified"
	oidcCodeFlowInvalid      = "oidc_flow_invalid"
	oidcCodeInvalid          = "oauth_code_invalid"
)

const (
	oidcDiscoveryTTL   = time.Hour
	oidcFlowCookieName = "multica_oidc_flow"
	oidcFlowCookieTTL  = 10 * time.Minute
	oidcStateMaxLen    = 512
	oidcVerifierLen    = 64
	oidcLoginFailedMsg = "failed to reach the OIDC provider"
)

// OidcPublicConfig is the /api/config view of the OIDC SSO deployment
// settings. The web login page needs issuer-independent values only: it
// redirects the browser to /auth/oidc/start and labels the button. Nil when
// SSO is not enabled, so older clients and the managed-cloud shape are
// unchanged.
type OidcPublicConfig struct {
	Issuer      string `json:"issuer"`
	ClientID    string `json:"client_id"`
	Scopes      string `json:"scopes"`
	ButtonLabel string `json:"button_label"`
}

// OidcPublicConfigFromEnv reports the public OIDC SSO config, or nil when the
// deployment has not enabled SSO. Re-read on every config request so
// operators can flip it without a frontend rebuild.
func OidcPublicConfigFromEnv() *OidcPublicConfig {
	cfg, ok := oidcConfigFromEnv()
	if !ok {
		return nil
	}
	scopes := strings.TrimSpace(os.Getenv("OIDC_SCOPES"))
	if scopes == "" {
		scopes = "openid email profile"
	}
	label := strings.TrimSpace(os.Getenv("OIDC_BUTTON_LABEL"))
	if label == "" {
		label = "Continue with SSO"
	}
	return &OidcPublicConfig{
		Issuer:      cfg.issuer,
		ClientID:    cfg.clientID,
		Scopes:      scopes,
		ButtonLabel: label,
	}
}

type oidcConfig struct {
	issuer       string
	clientID     string
	clientSecret string
	scopes       string
}

// oidcConfigFromEnv requires the explicit OIDC_ENABLED switch plus the three
// provider values. The explicit switch matters for the SSO gate: a half-set
// or mistyped OIDC_ISSUER must never silently lock every user out of the
// OTP path.
func oidcConfigFromEnv() (oidcConfig, bool) {
	if os.Getenv("OIDC_ENABLED") != "true" {
		return oidcConfig{}, false
	}
	issuer := strings.TrimRight(strings.TrimSpace(os.Getenv("OIDC_ISSUER")), "/")
	clientID := strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID"))
	clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
	scopes := strings.TrimSpace(os.Getenv("OIDC_SCOPES"))
	if scopes == "" {
		scopes = "openid email profile"
	}
	if issuer == "" || clientID == "" || clientSecret == "" {
		return oidcConfig{}, false
	}
	return oidcConfig{issuer: issuer, clientID: clientID, clientSecret: clientSecret, scopes: scopes}, true
}

// Endpoints discovered from the provider's well-known document.
type oidcEndpoints struct {
	authorize string
	token     string
	userinfo  string
}

type oidcDiscoveryEntry struct {
	endpoints oidcEndpoints
	fetched   time.Time
}

var (
	oidcDiscoveryMu    sync.Mutex
	oidcDiscoveryCache = map[string]oidcDiscoveryEntry{}
	oidcHTTPClient     = &http.Client{Timeout: 15 * time.Second}
)

// discoverOIDCEndpoints fetches (and caches) the provider's
// /.well-known/openid-configuration document. Failures are not cached so a
// briefly unavailable provider recovers on the next attempt.
func discoverOIDCEndpoints(ctx context.Context, issuer string) (oidcEndpoints, error) {
	oidcDiscoveryMu.Lock()
	if entry, ok := oidcDiscoveryCache[issuer]; ok && time.Since(entry.fetched) < oidcDiscoveryTTL {
		oidcDiscoveryMu.Unlock()
		return entry.endpoints, nil
	}
	oidcDiscoveryMu.Unlock()

	wellKnown := issuer + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, wellKnown, nil)
	if err != nil {
		return oidcEndpoints{}, err
	}
	resp, err := oidcHTTPClient.Do(req)
	if err != nil {
		return oidcEndpoints{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return oidcEndpoints{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return oidcEndpoints{}, fmt.Errorf("discovery returned status %d", resp.StatusCode)
	}
	var doc struct {
		Issuer    string `json:"issuer"`
		Authorize string `json:"authorization_endpoint"`
		Token     string `json:"token_endpoint"`
		Userinfo  string `json:"userinfo_endpoint"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return oidcEndpoints{}, err
	}
	if doc.Authorize == "" || doc.Token == "" || doc.Userinfo == "" {
		return oidcEndpoints{}, fmt.Errorf("discovery document is missing required endpoints")
	}
	endpoints := oidcEndpoints{authorize: doc.Authorize, token: doc.Token, userinfo: doc.Userinfo}
	oidcDiscoveryMu.Lock()
	oidcDiscoveryCache[issuer] = oidcDiscoveryEntry{endpoints: endpoints, fetched: time.Now()}
	oidcDiscoveryMu.Unlock()
	return endpoints, nil
}

// resetOIDCDiscoveryCache drops every cached discovery document. Test-only.
func resetOIDCDiscoveryCache() {
	oidcDiscoveryMu.Lock()
	oidcDiscoveryCache = map[string]oidcDiscoveryEntry{}
	oidcDiscoveryMu.Unlock()
}

type oidcFlow struct {
	// PKCE verifier generated at /auth/oidc/start.
	Verifier string `json:"v"`
	// The web-packed login state relayed through the provider unchanged.
	State string `json:"s"`
}

func (h *Handler) OidcStart(w http.ResponseWriter, r *http.Request) {
	cfg, ok := oidcConfigFromEnv()
	if !ok {
		writeFeatureDisabled(w, "oidc_login_not_configured", "OIDC login is not configured")
		return
	}

	state := r.URL.Query().Get("state")
	if state == "" || len(state) > oidcStateMaxLen || strings.ContainsAny(state, " \t\r\n\"") {
		writeError(w, http.StatusBadRequest, "invalid state parameter")
		return
	}
	redirectURI := r.URL.Query().Get("redirect_uri")
	if u, err := url.Parse(redirectURI); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeError(w, http.StatusBadRequest, "invalid redirect_uri parameter")
		return
	}

	endpoints, err := discoverOIDCEndpoints(r.Context(), cfg.issuer)
	if err != nil {
		slog.Error("oidc discovery failed", append(logger.RequestAttrs(r), "issuer", cfg.issuer, "error", err)...)
		writeError(w, http.StatusBadGateway, oidcLoginFailedMsg)
		return
	}

	verifier, err := oidcRandomValue(oidcVerifierLen)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start OIDC login")
		return
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	flow, err := json.Marshal(oidcFlow{Verifier: verifier, State: state})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start OIDC login")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     oidcFlowCookieName,
		Value:    base64.RawURLEncoding.EncodeToString(flow),
		Path:     "/auth",
		MaxAge:   int(oidcFlowCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   auth.SecureCookie(),
		SameSite: http.SameSiteLaxMode, // must survive the provider's cross-site redirect back to /auth/callback
	})

	authorize, err := url.Parse(endpoints.authorize)
	if err != nil {
		writeError(w, http.StatusBadGateway, oidcLoginFailedMsg)
		return
	}
	q := authorize.Query()
	q.Set("client_id", cfg.clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("scope", cfg.scopes)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	authorize.RawQuery = q.Encode()

	http.Redirect(w, r, authorize.String(), http.StatusFound)
}

type OidcLoginRequest struct {
	Code        string `json:"code"`
	State       string `json:"state"`
	RedirectURI string `json:"redirect_uri"`
}

type oidcTokenResponse struct {
	AccessToken string `json:"access_token"`
}

type oidcUserInfo struct {
	Email         string `json:"email"`
	EmailVerified *bool  `json:"email_verified"`
	Name          string `json:"name"`
	Username      string `json:"preferred_username"`
	Picture       string `json:"picture"`
}

// OidcLogin completes the SSO flow: validate the browser's flow cookie,
// exchange the authorization code with the provider, resolve the user by
// email (creating the account on first login), and issue the standard JWT
// session. The response shape matches GoogleLogin so every client keeps
// working unchanged.
func (h *Handler) OidcLogin(w http.ResponseWriter, r *http.Request) {
	cfg, ok := oidcConfigFromEnv()
	if !ok {
		writeFeatureDisabled(w, "oidc_login_not_configured", "OIDC login is not configured")
		return
	}

	var req OidcLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Code == "" || req.State == "" || req.RedirectURI == "" {
		writeError(w, http.StatusBadRequest, "code, state and redirect_uri are required")
		return
	}

	cookie, err := r.Cookie(oidcFlowCookieName)
	if err != nil || cookie.Value == "" {
		writeErrorCode(w, http.StatusBadRequest, oidcCodeFlowInvalid, "OIDC sign-in session expired; please try again")
		return
	}
	flowRaw, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		writeErrorCode(w, http.StatusBadRequest, oidcCodeFlowInvalid, "OIDC sign-in session expired; please try again")
		return
	}
	var flow oidcFlow
	if err := json.Unmarshal(flowRaw, &flow); err != nil || flow.Verifier == "" {
		writeErrorCode(w, http.StatusBadRequest, oidcCodeFlowInvalid, "OIDC sign-in session expired; please try again")
		return
	}
	if subtle.ConstantTimeCompare([]byte(flow.State), []byte(req.State)) != 1 {
		writeErrorCode(w, http.StatusBadRequest, oidcCodeFlowInvalid, "OIDC sign-in session expired; please try again")
		return
	}

	endpoints, err := discoverOIDCEndpoints(r.Context(), cfg.issuer)
	if err != nil {
		slog.Error("oidc discovery failed", append(logger.RequestAttrs(r), "issuer", cfg.issuer, "error", err)...)
		writeError(w, http.StatusBadGateway, oidcLoginFailedMsg)
		return
	}

	tokenResp, err := oidcHTTPClient.PostForm(endpoints.token, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {req.Code},
		"redirect_uri":  {req.RedirectURI},
		"client_id":     {cfg.clientID},
		"client_secret": {cfg.clientSecret},
		"code_verifier": {flow.Verifier},
	})
	if err != nil {
		slog.Error("oidc token exchange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusBadGateway, "failed to exchange code with the OIDC provider")
		return
	}
	defer tokenResp.Body.Close()
	tokenBody, err := io.ReadAll(io.LimitReader(tokenResp.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to read the OIDC token response")
		return
	}
	if tokenResp.StatusCode != http.StatusOK {
		slog.Error("oidc token exchange returned error", append(logger.RequestAttrs(r), "status", tokenResp.StatusCode, "body", string(tokenBody))...)
		var tokenErr struct {
			Error string `json:"error"`
		}
		// Only a valid invalid_grant response identifies a rejected
		// authorization code; everything else is a server-side failure.
		if err := json.Unmarshal(tokenBody, &tokenErr); err == nil &&
			tokenResp.StatusCode == http.StatusBadRequest && tokenErr.Error == "invalid_grant" {
			writeErrorCode(w, http.StatusBadRequest, oidcCodeInvalid, "failed to exchange code with the OIDC provider")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to exchange code with the OIDC provider")
		return
	}
	var token oidcTokenResponse
	if err := json.Unmarshal(tokenBody, &token); err != nil || strings.TrimSpace(token.AccessToken) == "" {
		slog.Error("oidc token response has no access token")
		writeError(w, http.StatusBadGateway, "invalid OIDC token response")
		return
	}

	user, err := h.fetchOIDCUserInfo(r, endpoints.userinfo, token.AccessToken)
	if err != nil {
		var oidcErr *oidcUserinfoError
		if errors.As(err, &oidcErr) {
			if oidcErr.code != "" {
				writeErrorCode(w, oidcErr.status, oidcErr.code, oidcErr.message)
			} else {
				writeError(w, oidcErr.status, oidcErr.message)
			}
			return
		}
		slog.Error("oidc userinfo failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from the OIDC provider")
		return
	}

	email := strings.ToLower(strings.TrimSpace(user.Email))
	if email == "" {
		writeErrorCode(w, http.StatusBadRequest, oidcCodeAccountNoEmail, "The identity provider did not provide an email address for this sign-in")
		return
	}
	if auth.IsTemporarilyDisabledUserEmail(email) {
		writeErrorCode(w, http.StatusForbidden, googleLoginCodeAccountDisabled, auth.TemporarilyDisabledUserError)
		return
	}

	resolved, isNew, err := h.findOrCreateOidcUser(r.Context(), email, oidcDisplayName(user))
	if err != nil {
		if errors.Is(err, auth.ErrTemporarilyDisabledUser) {
			writeErrorCode(w, http.StatusForbidden, googleLoginCodeAccountDisabled, auth.TemporarilyDisabledUserError)
			return
		}
		slog.Warn("login user lookup or creation failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	if isNew {
		evt := analytics.Signup(uuidToString(resolved.ID), resolved.Email, signupSourceFromRequest(r))
		evt.Properties["auth_method"] = "oidc"
		obsmetrics.RecordEvent(h.Analytics, h.Metrics, evt)
	}

	// Adopt the provider's display name and avatar like GoogleLogin does: the
	// default name is the email prefix, so a real name claim replaces it; an
	// existing avatar is never overwritten.
	needsUpdate := false
	newName := resolved.Name
	newAvatar := resolved.AvatarUrl
	displayName := oidcDisplayName(user)
	if at := strings.Index(email, "@"); at > 0 && displayName != "" && resolved.Name == email[:at] {
		newName = displayName
		needsUpdate = true
	}
	if user.Picture != "" && !resolved.AvatarUrl.Valid {
		newAvatar = pgtype.Text{String: user.Picture, Valid: true}
		needsUpdate = true
	}
	if needsUpdate {
		if updated, err := h.Queries.UpdateUser(r.Context(), db.UpdateUserParams{
			ID:        resolved.ID,
			Name:      newName,
			AvatarUrl: newAvatar,
		}); err == nil {
			resolved = updated
		}
	}

	tokenString, err := h.issueJWT(resolved)
	if err != nil {
		slog.Warn("oidc login failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	if err := auth.SetAuthCookies(w, tokenString); err != nil {
		slog.Warn("failed to set auth cookies", "error", err)
	}
	// The flow is complete; drop the cookie instead of leaving it to expire.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcFlowCookieName,
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   auth.SecureCookie(),
		SameSite: http.SameSiteLaxMode,
	})

	if h.CFSigner != nil {
		for _, c := range h.CFSigner.SignedCookies(time.Now().Add(72 * time.Hour)) {
			http.SetCookie(w, c)
		}
	}

	slog.Info("user logged in via oidc", append(logger.RequestAttrs(r), "user_id", uuidToString(resolved.ID), "email", resolved.Email)...)
	writeJSON(w, http.StatusOK, LoginResponse{
		Token: tokenString,
		User:  h.userToResponse(resolved),
	})
}

type oidcUserinfoError struct {
	status  int
	code    string
	message string
}

func (e *oidcUserinfoError) Error() string { return e.message }

func (h *Handler) fetchOIDCUserInfo(r *http.Request, endpoint, accessToken string) (*oidcUserInfo, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := oidcHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		slog.Error("oidc userinfo returned error", "status", resp.StatusCode, "body", string(body))
		return nil, &oidcUserinfoError{status: http.StatusBadGateway, message: "failed to fetch user info from the OIDC provider"}
	}
	var info *oidcUserInfo
	if err := json.Unmarshal(body, &info); err != nil || info == nil {
		return nil, &oidcUserinfoError{status: http.StatusBadGateway, message: "invalid OIDC user info"}
	}
	if info.EmailVerified != nil && !*info.EmailVerified {
		return nil, &oidcUserinfoError{status: http.StatusForbidden, code: oidcCodeEmailNotVerified, message: "The identity provider has not verified this email address"}
	}
	return info, nil
}

// findOrCreateOidcUser is findOrCreateUser without checkSignupAllowed: the
// provider realm is the trust boundary for SSO logins. The temporarily
// disabled blocklist still applies — it is a kill switch, not an allowlist.
func (h *Handler) findOrCreateOidcUser(ctx context.Context, email, displayName string) (user db.User, isNew bool, err error) {
	if auth.IsTemporarilyDisabledUserEmail(email) {
		return db.User{}, false, auth.ErrTemporarilyDisabledUser
	}
	user, err = h.Queries.GetUserByEmail(ctx, email)
	isNew = isNotFound(err)
	if err != nil && !isNew {
		return db.User{}, false, err
	}
	if !isNew {
		if auth.IsTemporarilyDisabledUser(uuidToString(user.ID), user.Email) {
			return db.User{}, false, auth.ErrTemporarilyDisabledUser
		}
		return user, false, nil
	}
	name := displayName
	if name == "" {
		if at := strings.Index(email, "@"); at > 0 {
			name = email[:at]
		} else {
			name = email
		}
	}
	created, err := h.Queries.CreateUser(ctx, db.CreateUserParams{
		Name:  name,
		Email: email,
	})
	if err != nil {
		return db.User{}, false, err
	}
	return created, true, nil
}

func oidcDisplayName(info *oidcUserInfo) string {
	if name := strings.TrimSpace(info.Name); name != "" {
		return name
	}
	return strings.TrimSpace(info.Username)
}

func oidcRandomValue(len int) (string, error) {
	raw := make([]byte, len)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
