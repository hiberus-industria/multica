package handler

// HIBERUS: tests for the fork's OIDC SSO login (internal/handler/oidc.go).
// The provider is faked with httptest servers standing in for the well-known,
// token and userinfo endpoints, so the discovery, exchange and userinfo paths
// run for real against arbitrary URLs. DB-backed cases use the shared handler
// test fixture.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

const fakeOIDCClientSecret = "fake-oidc-secret"

type fakeOIDCProvider struct {
	srv          *httptest.Server
	tokenStatus  atomic.Int32
	tokenBody    atomic.Value // string
	userStatus   atomic.Int32
	userBody     atomic.Value // string
	wellKnownHit atomic.Int32
}

func newFakeOIDCProvider(t *testing.T, userinfoJSON string) *fakeOIDCProvider {
	t.Helper()
	p := &fakeOIDCProvider{}
	p.tokenStatus.Store(http.StatusOK)
	p.tokenBody.Store(`{"access_token":"fake-access-token"}`)
	p.userStatus.Store(http.StatusOK)
	p.userBody.Store(userinfoJSON)

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		p.wellKnownHit.Add(1)
		doc, _ := json.Marshal(map[string]string{
			"issuer":                 p.srv.URL,
			"authorization_endpoint": p.srv.URL + "/authorize",
			"token_endpoint":         p.srv.URL + "/token",
			"userinfo_endpoint":      p.srv.URL + "/userinfo",
		})
		writeFakeJSON(w, http.StatusOK, string(doc))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("token form parse: %v", err)
		}
		if r.Form.Get("client_secret") != fakeOIDCClientSecret {
			t.Errorf("token exchange used wrong client secret: %q", r.Form.Get("client_secret"))
		}
		if r.Form.Get("grant_type") != "authorization_code" {
			t.Errorf("token exchange used grant_type %q", r.Form.Get("grant_type"))
		}
		writeFakeJSON(w, int(p.tokenStatus.Load()), p.tokenBody.Load().(string))
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer fake-access-token" {
			t.Errorf("userinfo used wrong authorization header: %q", got)
		}
		writeFakeJSON(w, int(p.userStatus.Load()), p.userBody.Load().(string))
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

func writeFakeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func setOIDCEnv(t *testing.T, issuer string) {
	t.Helper()
	t.Setenv("OIDC_ENABLED", "true")
	t.Setenv("OIDC_ISSUER", issuer)
	t.Setenv("OIDC_CLIENT_ID", "multica-web")
	t.Setenv("OIDC_CLIENT_SECRET", fakeOIDCClientSecret)
	resetOIDCDiscoveryCache()
	t.Cleanup(resetOIDCDiscoveryCache)
}

// startOIDCFlow drives GET /auth/oidc/start and returns the state carried
// through, the PKCE verifier stashed in the flow cookie, and the response.
func startOIDCFlow(t *testing.T, h *Handler, state, redirectURI string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/start?state="+state+"&redirect_uri="+redirectURI, nil)
	resp := testutil.Call(t, h.OidcStart, req).Want(http.StatusFound)
	var flowCookie *http.Cookie
	for _, cookie := range resp.Result().Cookies() {
		if cookie.Name == oidcFlowCookieName {
			flowCookie = cookie
		}
	}
	if flowCookie == nil || flowCookie.Value == "" {
		t.Fatal("OIDC start did not set the flow cookie")
	}
	raw, err := base64.RawURLEncoding.DecodeString(flowCookie.Value)
	if err != nil {
		t.Fatalf("flow cookie is not base64url: %v", err)
	}
	var flow oidcFlow
	if err := json.Unmarshal(raw, &flow); err != nil {
		t.Fatalf("flow cookie is not valid JSON: %v", err)
	}
	return resp.Result(), flow.Verifier
}

func TestOidcStartRedirectsToProvider(t *testing.T) {
	p := newFakeOIDCProvider(t, `{"email":"unused@example.com"}`)
	setOIDCEnv(t, p.srv.URL)
	h := newTestHandler(Config{})

	resp, verifier := startOIDCFlow(t, h, "platform:desktop", "http://localhost:3000/auth/callback")
	location := resp.Header.Get("Location")
	if !strings.HasPrefix(location, p.srv.URL+"/authorize?") {
		t.Fatalf("start did not redirect to the provider authorize endpoint: %s", location)
	}
	u, err := url.Parse(location)
	if err != nil {
		t.Fatalf("authorize location is not a URL: %v", err)
	}
	q := u.Query()
	if q.Get("client_id") != "multica-web" {
		t.Errorf("authorize client_id = %q", q.Get("client_id"))
	}
	if q.Get("response_type") != "code" {
		t.Errorf("authorize response_type = %q", q.Get("response_type"))
	}
	if q.Get("scope") != "openid email profile" {
		t.Errorf("authorize scope = %q", q.Get("scope"))
	}
	if q.Get("state") != "platform:desktop" {
		t.Errorf("authorize state = %q, want the web-packed state passed through", q.Get("state"))
	}
	if q.Get("code_challenge_method") != "S256" {
		t.Errorf("authorize code_challenge_method = %q", q.Get("code_challenge_method"))
	}
	sum := sha256.Sum256([]byte(verifier))
	if got := base64.RawURLEncoding.EncodeToString(sum[:]); got != q.Get("code_challenge") {
		t.Errorf("code_challenge does not match the flow cookie verifier: %s vs %s", got, q.Get("code_challenge"))
	}
}

func TestOidcStartRejectsBadInput(t *testing.T) {
	p := newFakeOIDCProvider(t, `{}`)
	setOIDCEnv(t, p.srv.URL)
	h := newTestHandler(Config{})

	tests := []struct {
		name   string
		target string
	}{
		{"missing state", "/auth/oidc/start?redirect_uri=http://localhost:3000/auth/callback"},
		{"oversize state", "/auth/oidc/start?state=" + strings.Repeat("x", 600) + "&redirect_uri=http://localhost:3000/auth/callback"},
		{"state with control characters", "/auth/oidc/start?state=bad%0Astate&redirect_uri=http://localhost:3000/auth/callback"},
		{"missing redirect_uri", "/auth/oidc/start?state=abc"},
		{"non-http redirect_uri", "/auth/oidc/start?state=abc&redirect_uri=javascript:alert(1)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			testutil.Call(t, h.OidcStart, req).Want(http.StatusBadRequest)
		})
	}
}

func TestOidcLoginSuccessExistingUser(t *testing.T) {
	p := newFakeOIDCProvider(t, `{"email":" OIDC-EXISTING@example.com ","email_verified":true,"name":"Existing OIDC User"}`)
	setOIDCEnv(t, p.srv.URL)
	email := "oidc-existing@example.com"
	userID := dbfx.User(t, "OIDC Existing", email)
	h := newTestHandler(Config{AllowSignup: false, AllowedEmailDomains: []string{"company.com"}})
	h.Queries = testHandler.Queries

	_, verifier := startOIDCFlow(t, h, "sso,platform:desktop", "http://localhost:3000/auth/callback")
	req := httptest.NewRequest(http.MethodPost, "/auth/oidc", strings.NewReader(
		`{"code":"fake-code","state":"sso,platform:desktop","redirect_uri":"http://localhost:3000/auth/callback"}`))
	req.AddCookie(&http.Cookie{Name: oidcFlowCookieName, Value: encodeFlowForTest(t, verifier, "sso,platform:desktop")})
	var got LoginResponse
	resp := testutil.Call(t, h.OidcLogin, req).Want(http.StatusOK).JSON(&got)
	if got.Token == "" || got.User.ID != userID || got.User.Email != email {
		t.Fatalf("unexpected OIDC login: token present=%t user=%+v", got.Token != "", got.User)
	}
	var authCookie, csrfCookie *http.Cookie
	flowCleared := false
	for _, cookie := range resp.Result().Cookies() {
		switch cookie.Name {
		case auth.AuthCookieName:
			authCookie = cookie
		case auth.CSRFCookieName:
			csrfCookie = cookie
		case oidcFlowCookieName:
			flowCleared = cookie.MaxAge < 0
		}
	}
	if authCookie == nil || authCookie.Value != got.Token || csrfCookie == nil || csrfCookie.Value == "" {
		t.Fatal("successful OIDC login must return matching auth and CSRF cookies")
	}
	if !flowCleared {
		t.Fatal("successful OIDC login must clear the flow cookie")
	}

	// The issued session must work through the same middleware as any other
	// browser session.
	meReq := httptest.NewRequest(http.MethodGet, "/users/me", nil)
	meReq.AddCookie(authCookie)
	protected := middleware.Auth(h.Queries, nil, nil, nil)(http.HandlerFunc(h.GetMe))
	var me UserResponse
	testutil.Call(t, protected.ServeHTTP, meReq).Want(http.StatusOK).JSON(&me)
	if me.ID != userID || me.Email != email {
		t.Fatalf("OIDC session resolved to the wrong user: %+v", me)
	}
}

func TestOidcLoginJITCreatesUserIgnoringAllowlist(t *testing.T) {
	p := newFakeOIDCProvider(t, `{"email":"new-hire@company.com","email_verified":true,"name":"New Hire","preferred_username":"newhire"}`)
	setOIDCEnv(t, p.srv.URL)
	// Signup is locked down for the email paths, but the provider realm is
	// the trust boundary for SSO: a first login must create the account.
	h := newTestHandler(Config{AllowSignup: false, AllowedEmailDomains: []string{"unrelated.com"}})
	h.Queries = testHandler.Queries
	email := "new-hire@company.com"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1`, email)

	_, verifier := startOIDCFlow(t, h, "sso", "http://localhost:3000/auth/callback")
	req := httptest.NewRequest(http.MethodPost, "/auth/oidc", strings.NewReader(
		`{"code":"fake-code","state":"sso","redirect_uri":"http://localhost:3000/auth/callback"}`))
	req.AddCookie(&http.Cookie{Name: oidcFlowCookieName, Value: encodeFlowForTest(t, verifier, "sso")})
	var got LoginResponse
	testutil.Call(t, h.OidcLogin, req).Want(http.StatusOK).JSON(&got)
	if got.Token == "" || got.User.Email != email {
		t.Fatalf("JIT login failed: token present=%t user=%+v", got.Token != "", got.User)
	}
	if got.User.Name != "New Hire" {
		t.Fatalf("JIT user name = %q, want the provider display name", got.User.Name)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM "user" WHERE email = $1`, email); n != 1 {
		t.Fatalf("JIT created %d users, want 1", n)
	}
}

func TestOidcLoginFailureMatrix(t *testing.T) {
	tests := []struct {
		name        string
		tokenStatus int
		tokenBody   string
		userStatus  int
		userBody    string
		// When set, the request omits the flow cookie entirely.
		noFlowCookie bool
		flowState    string
		reqBody      string
		wantStatus   int
		wantCode     string
	}{
		{
			name:        "invalid grant",
			tokenStatus: http.StatusBadRequest, tokenBody: `{"error":"invalid_grant"}`,
			wantStatus: http.StatusBadRequest, wantCode: "oauth_code_invalid",
		},
		{
			name:        "provider rejects client",
			tokenStatus: http.StatusUnauthorized, tokenBody: `{"error":"invalid_client"}`,
			wantStatus: http.StatusBadGateway,
		},
		{
			name:        "malformed token response",
			tokenStatus: http.StatusOK, tokenBody: `{`,
			wantStatus: http.StatusBadGateway,
		},
		{
			name:        "token response without access token",
			tokenStatus: http.StatusOK, tokenBody: `{"token_type":"Bearer"}`,
			wantStatus: http.StatusBadGateway,
		},
		{
			name:       "userinfo unverified email",
			userBody:   `{"email":"a@b.com","email_verified":false}`,
			wantStatus: http.StatusForbidden, wantCode: "oidc_email_not_verified",
		},
		{
			name:       "userinfo without email",
			userBody:   `{"name":"No Email"}`,
			wantStatus: http.StatusBadRequest, wantCode: "oidc_account_no_email",
		},
		{
			name:       "userinfo error status",
			userStatus: http.StatusUnauthorized, userBody: `{"error":"invalid_token"}`,
			wantStatus: http.StatusBadGateway,
		},
		{
			name:       "malformed userinfo",
			userBody:   `<html>`,
			wantStatus: http.StatusBadGateway,
		},
		{
			name:         "missing flow cookie",
			noFlowCookie: true,
			wantStatus:   http.StatusBadRequest, wantCode: "oidc_flow_invalid",
		},
		{
			name:       "state mismatch",
			flowState:  "other-state",
			wantStatus: http.StatusBadRequest, wantCode: "oidc_flow_invalid",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			userBody := tt.userBody
			if userBody == "" {
				userBody = `{"email":"a@b.com","email_verified":true}`
			}
			p := newFakeOIDCProvider(t, userBody)
			setOIDCEnv(t, p.srv.URL)
			if tt.tokenStatus != 0 {
				p.tokenStatus.Store(int32(tt.tokenStatus))
			}
			if tt.tokenBody != "" {
				p.tokenBody.Store(tt.tokenBody)
			}
			if tt.userStatus != 0 {
				p.userStatus.Store(int32(tt.userStatus))
			}
			h := newTestHandler(Config{})
			h.Queries = testHandler.Queries

			state := "sso"
			verifier := ""
			if !tt.noFlowCookie {
				_, verifier = startOIDCFlow(t, h, "sso", "http://localhost:3000/auth/callback")
			}
			if tt.flowState != "" {
				state = tt.flowState
			}
			body := tt.reqBody
			if body == "" {
				body = `{"code":"fake-code","state":"` + state + `","redirect_uri":"http://localhost:3000/auth/callback"}`
			}
			req := httptest.NewRequest(http.MethodPost, "/auth/oidc", strings.NewReader(body))
			if !tt.noFlowCookie {
				req.AddCookie(&http.Cookie{Name: oidcFlowCookieName, Value: encodeFlowForTest(t, verifier, "sso")})
			}
			var got struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			testutil.Call(t, h.OidcLogin, req).Want(tt.wantStatus).JSON(&got)
			if tt.wantCode != "" && got.Code != tt.wantCode {
				t.Fatalf("got code=%q, want %q", got.Code, tt.wantCode)
			}
			if got.Error == "" {
				t.Fatal("failure responses must carry a message")
			}
		})
	}
}

func TestOidcLoginNotConfigured(t *testing.T) {
	// SSO disabled: both endpoints refuse as a deliberate feature gate.
	h := newTestHandler(Config{})
	startReq := httptest.NewRequest(http.MethodGet, "/auth/oidc/start?state=abc&redirect_uri=http://localhost:3000/auth/callback", nil)
	var startGot struct {
		Code string `json:"code"`
	}
	testutil.Call(t, h.OidcStart, startReq).Want(http.StatusForbidden).JSON(&startGot)
	if startGot.Code != "oidc_login_not_configured" {
		t.Fatalf("start code = %q", startGot.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/auth/oidc", strings.NewReader(`{"code":"c","state":"s","redirect_uri":"http://x/cb"}`))
	var got struct {
		Code string `json:"code"`
	}
	testutil.Call(t, h.OidcLogin, req).Want(http.StatusForbidden).JSON(&got)
	if got.Code != "oidc_login_not_configured" {
		t.Fatalf("login code = %q", got.Code)
	}
}

func TestOidcDiscoveryFailure(t *testing.T) {
	// Issuer points at a closed port: discovery fails with 502, not a panic.
	setOIDCEnv(t, "http://127.0.0.1:1/realms/none")
	h := newTestHandler(Config{})
	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/start?state=abc&redirect_uri=http://localhost:3000/auth/callback", nil)
	testutil.Call(t, h.OidcStart, req).Want(http.StatusBadGateway)
}

func TestOidcDiscoveryIsCached(t *testing.T) {
	p := newFakeOIDCProvider(t, `{}`)
	setOIDCEnv(t, p.srv.URL)
	h := newTestHandler(Config{})

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/auth/oidc/start?state=abc&redirect_uri=http://localhost:3000/auth/callback", nil)
		testutil.Call(t, h.OidcStart, req).Want(http.StatusFound)
	}
	if got := p.wellKnownHit.Load(); got != 1 {
		t.Fatalf("discovery document fetched %d times, want 1 (cached)", got)
	}
}

func encodeFlowForTest(t *testing.T, verifier, state string) string {
	t.Helper()
	raw, err := json.Marshal(oidcFlow{Verifier: verifier, State: state})
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
