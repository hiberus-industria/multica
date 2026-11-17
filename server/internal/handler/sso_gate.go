package handler

// HIBERUS: fork feature — the SSO gate. When OIDC SSO is enabled, the
// provider realm is the only sanctioned way in, so the OTP email-code and
// Google login paths are closed at the handler level. ALLOWED_EMAILS keeps
// its break-glass role: those addresses can still receive a verification
// code and log in when the identity provider is unreachable.

import "net/http"

const ssoGateBlockedCode = "auth_mode_sso"

// oidcSSOEnabled reports whether the deployment runs OIDC SSO in enforcing
// mode. Reads env the same way the OIDC login handler does (re-read per
// request), so the gate can never disagree with it about whether SSO is on.
func oidcSSOEnabled() bool {
	_, ok := oidcConfigFromEnv()
	return ok
}

// ssoGateAllowsEmail reports whether an email-based login path (OTP code or
// Google OAuth) may proceed. With SSO off every email passes; with SSO on
// only the explicitly allowlisted break-glass emails do.
func (h *Handler) ssoGateAllowsEmail(email string) bool {
	if !oidcSSOEnabled() {
		return true
	}
	return contains(h.cfg.AllowedEmails, email)
}

func writeSSOGateBlocked(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusForbidden, ssoGateBlockedCode, "Sign-in is handled by your organization's single sign-on")
}
