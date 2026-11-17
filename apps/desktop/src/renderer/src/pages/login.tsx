import { LoginPage } from "@multica/views/auth";
import { DragStrip } from "@multica/views/platform";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { useConfigStore } from "@multica/core/config";
import { useT } from "@multica/views/i18n";

function requireRuntimeAppUrl(): string {
  const runtimeConfig = window.desktopAPI.runtimeConfig;
  if (!runtimeConfig.ok) {
    throw new Error(
      "Invariant violated: DesktopLoginPage rendered before App accepted runtime config",
    );
  }
  return runtimeConfig.config.appUrl;
}

export function DesktopLoginPage() {
  const webUrl = requireRuntimeAppUrl();
  const { t } = useT("auth");
  // HIBERUS: fork feature — public OIDC SSO config; null when the server has
  // SSO disabled or predates the field.
  const oidcConfig = useConfigStore((state) => state.oidc);
  const handleWebLogin = () => {
    // Open web login page in the default browser with platform=desktop flag.
    // The web callback will redirect back via multica:// deep link with the token.
    window.desktopAPI.openExternal(
      `${webUrl}/login?platform=desktop`,
    );
  };

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        logo={<MulticaIcon mode="intro" size={48} />}
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
        // HIBERUS: fork feature — with SSO enabled the SSO button takes over
        // (it opens the web login, which is SSO-only there) and Google hides.
        oidc={
          oidcConfig
            ? {
                startUrl: `${webUrl}/login?platform=desktop`,
                buttonLabel: oidcConfig.buttonLabel,
                fallbackLabel: t(($) => $.web.sso_fallback),
              }
            : undefined
        }
        onGoogleLogin={oidcConfig ? undefined : handleWebLogin}
      />
    </div>
  );
}
