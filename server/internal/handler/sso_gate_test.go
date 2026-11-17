package handler

// HIBERUS: tests for the SSO gate (internal/handler/sso_gate.go): when OIDC
// SSO is active the email/OTP and Google login paths close, except for the
// break-glass emails in ALLOWED_EMAILS.

import (
	crand "crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func setSSOGateEnv(t *testing.T) {
	t.Helper()
	t.Setenv("OIDC_ENABLED", "true")
	t.Setenv("OIDC_ISSUER", "https://sso.example.com/realms/hiberus")
	t.Setenv("OIDC_CLIENT_ID", "multica-web")
	t.Setenv("OIDC_CLIENT_SECRET", "secret")
	t.Setenv("ALLOWED_EMAILS", "breakglass@hiberus.com")
	resetOIDCDiscoveryCache()
	t.Cleanup(resetOIDCDiscoveryCache)
}

func TestSSOGateAllowsEmail(t *testing.T) {
	tests := []struct {
		name    string
		ssoOn   bool
		email   string
		allowed bool
	}{
		{"sso off allows everything", false, "anyone@hiberus.com", true},
		{"sso on blocks unknown email", true, "anyone@hiberus.com", false},
		{"sso on allows break-glass email", true, "breakglass@hiberus.com", true},
		{"sso on is case insensitive", true, "BreakGlass@Hiberus.com", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.ssoOn {
				setSSOGateEnv(t)
			}
			h := newTestHandler(Config{AllowedEmails: []string{"breakglass@hiberus.com"}})
			if got := h.ssoGateAllowsEmail(tt.email); got != tt.allowed {
				t.Fatalf("ssoGateAllowsEmail(%q) with ssoOn=%t = %t, want %t", tt.email, tt.ssoOn, got, tt.allowed)
			}
		})
	}
}

func TestSSOGateBlocksOTPPaths(t *testing.T) {
	setSSOGateEnv(t)
	h := newTestHandler(Config{AllowedEmails: []string{"breakglass@hiberus.com"}})
	h.Queries = testHandler.Queries

	t.Run("send-code", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/send-code", strings.NewReader(`{"email":"user@hiberus.com"}`))
		var got struct {
			Code string `json:"code"`
		}
		testutil.Call(t, h.SendCode, req).Want(http.StatusForbidden).JSON(&got)
		if got.Code != ssoGateBlockedCode {
			t.Fatalf("send-code code = %q, want %q", got.Code, ssoGateBlockedCode)
		}
	})

	t.Run("verify-code", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/verify-code", strings.NewReader(`{"email":"user@hiberus.com","code":"123456"}`))
		var got struct {
			Code string `json:"code"`
		}
		testutil.Call(t, h.VerifyCode, req).Want(http.StatusForbidden).JSON(&got)
		if got.Code != ssoGateBlockedCode {
			t.Fatalf("verify-code code = %q, want %q", got.Code, ssoGateBlockedCode)
		}
	})

	t.Run("google", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/google", strings.NewReader(`{"code":"c"}`))
		var got struct {
			Code string `json:"code"`
		}
		testutil.Call(t, h.GoogleLogin, req).Want(http.StatusForbidden).JSON(&got)
		if got.Code != ssoGateBlockedCode {
			t.Fatalf("google code = %q, want %q", got.Code, ssoGateBlockedCode)
		}
	})
}

func TestSSOGateBreakGlassPasses(t *testing.T) {
	setSSOGateEnv(t)
	// A unique break-glass address per run dodges the 60s per-email resend
	// limit the OTP path enforces, and its verification codes are cleaned up.
	email := "breakglass-" + strings.ToLower(randomTestSuffix()) + "@hiberus.com"
	t.Setenv("ALLOWED_EMAILS", email)
	h := newTestHandler(Config{AllowedEmails: []string{email}})
	h.Queries = testHandler.Queries
	h.EmailService = service.NewEmailService()
	dbfx.Cleanup(t, `DELETE FROM verification_code WHERE email = $1`, email)

	// The gate must let a break-glass email through to the OTP machinery.
	// The email service runs in dev mode here (codes print to stdout), so a
	// successful send is the proof the gate did not refuse.
	req := httptest.NewRequest(http.MethodPost, "/auth/send-code", strings.NewReader(`{"email":"`+email+`"}`))
	var got struct {
		Message string `json:"message"`
	}
	testutil.Call(t, h.SendCode, req).Want(http.StatusOK).JSON(&got)
}

func randomTestSuffix() string {
	raw := make([]byte, 8)
	if _, err := crand.Read(raw); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(raw)
}
