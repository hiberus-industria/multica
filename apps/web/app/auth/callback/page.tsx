"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@multica/core/auth";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { paths, resolvePostAuthDestination } from "@multica/core/paths";
import { api } from "@multica/core/api";
import { createLogger } from "@multica/core/logger";
import { validateCliCallback, redirectToCliCallback } from "@multica/views/auth";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@multica/ui/components/ui/card";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";
import { Loader2 } from "@multica/ui/icons";
import { CliCallbackError } from "@/features/auth/cli-callback-error";
import { callbackErrorFrom, type CallbackError } from "./callback-error";

const authLogger = createLogger("auth.callback");

function CallbackContent() {
  const { t } = useT("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  // HIBERUS: fork feature — OIDC SSO login.
  const loginWithOidc = useAuthStore((s) => s.loginWithOidc);
  const [error, setError] = useState<CallbackError | null>(null);
  const [desktopToken, setDesktopToken] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const errorParam = searchParams.get("error");
    if (errorParam) {
      authLogger.warn("Google OAuth returned an error parameter", errorParam);
      setError(
        errorParam === "access_denied"
          ? { kind: "access_denied" }
          : { kind: "login_failed" },
      );
      return;
    }

    if (!code) {
      setError({ kind: "missing_code" });
      return;
    }

    const state = searchParams.get("state") || "";
    const stateParts = state.split(",");
    // HIBERUS: fork feature — "sso" marks a login that went through the OIDC
    // start route; the rest of the packed state is shared with the Google flow.
    const isOidc = stateParts.includes("sso");
    const isDesktop = stateParts.includes("platform:desktop");
    const nextPart = stateParts.find((p) => p.startsWith("next:"));
    // Strip "next:" prefix, then drop anything that isn't a safe relative path
    // so an attacker-controlled `state=next:https://evil` cannot redirect here.
    const nextUrl = sanitizeNextUrl(nextPart ? nextPart.slice(5) : null);

    // CLI callback params — carried across the Google OAuth round-trip so
    // headless/WSL2 `multica login` can receive the JWT after browser-based
    // Google auth completes.
    const cliCallbackPart = stateParts.find((p) => p.startsWith("cli_callback:"));
    const cliStatePart = stateParts.find((p) => p.startsWith("cli_state:"));
    let cliCallback: string | null = null;
    let cliState = "";
    try {
      if (cliCallbackPart !== undefined) {
        cliCallback = decodeURIComponent(cliCallbackPart.slice("cli_callback:".length));
        if (!validateCliCallback(cliCallback)) {
          setError({ kind: "invalid_cli_callback" });
          return;
        }
      }
      if (cliStatePart !== undefined) {
        cliState = decodeURIComponent(cliStatePart.slice("cli_state:".length));
      }
    } catch {
      setError({ kind: "invalid_cli_callback" });
      return;
    }

    const redirectUri = `${window.location.origin}/auth/callback`;

    // HIBERUS: fork feature — the "sso" marker in the state selects the OIDC
    // exchange endpoint; everything downstream (CLI handoff, desktop deep
    // link, post-auth routing) is identical for both providers.
    const exchangeApi = isOidc
      ? () => api.oidcLogin(code, state, redirectUri)
      : () => api.googleLogin(code, redirectUri);

    if (cliCallback) {
      // CLI login flow: exchange the OAuth code for a JWT, then redirect the
      // token back to the CLI's local HTTP listener (e.g. WSL2 host).
      exchangeApi()
        .then(({ token }) => {
          redirectToCliCallback(cliCallback, token, cliState);
        })
        .catch((err) => {
          authLogger.error("CLI OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else if (isDesktop) {
      // Desktop flow: exchange code for token, then redirect via deep link
      exchangeApi()
        .then(({ token }) => {
          setDesktopToken(token);
          window.location.href = `multica://auth/callback?token=${encodeURIComponent(token)}`;
        })
        .catch((err) => {
          authLogger.error("Desktop OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else {
      // Normal web flow — through the store so cookie/token mode is handled.
      const complete = isOidc
        ? () => loginWithOidc(code, state, redirectUri)
        : () => loginWithGoogle(code, redirectUri);
      complete()
        .then(async (loggedInUser) => {
          const wsList = await api.listWorkspaces();
          qc.setQueryData(workspaceKeys.list(), wsList);
          const onboarded = loggedInUser.onboarded_at != null;

          // 1. nextUrl wins: a `next=/invite/<id>` always survives the OAuth
          //    round-trip — the user clicked a specific link and we should
          //    honor exactly that destination.
          if (nextUrl) {
            router.push(nextUrl);
            return;
          }

          // 2. Un-onboarded users may have pending invitations on their
          //    email even when no `next=` was carried (came from a fresh
          //    login on multica.ai instead of clicking the email link,
          //    or `state` was lost across the round-trip). Look them up by
          //    email and route to the batch /invitations page if any.
          //    Already-onboarded users skip this lookup — their new invites
          //    surface in the sidebar dropdown, not as a forced wall.
          if (!onboarded) {
            try {
              const invites = await api.listMyInvitations();
              if (invites.length > 0) {
                qc.setQueryData(workspaceKeys.myInvitations(), invites);
                router.push(paths.invitations());
                return;
              }
            } catch {
              // Network blip on the invite lookup is non-fatal — fall through
              // to the normal post-auth destination so the user isn't stuck
              // on a blank callback screen. Worst case they land on
              // /onboarding and the sidebar will surface invites later.
            }
          }

          // 3. Default: hand off to the resolver (onboarding for first-timers,
          //    first workspace for returning users, /workspaces/new for
          //    onboarded users with zero workspaces). Source-attribution
          //    backfill for onboarded users with no recorded source is
          //    handled by `<SourceBackfillModal />` inside the dashboard
          //    shell — not a route detour, so we route straight to dest.
          router.push(resolvePostAuthDestination(wsList, onboarded));
        })
        .catch((err) => {
          authLogger.error("Web OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    }
  }, [searchParams, loginWithGoogle, loginWithOidc, router, qc]);

  const errorDescription = (() => {
    if (!error) return null;
    switch (error.kind) {
      case "invalid_cli_callback":
        return null;
      case "raw":
        return error.text;
      case "missing_code":
        return t(($) => $.web.callback.missing_code);
      case "access_denied":
        return t(($) => $.web.callback.access_denied);
      case "login_failed":
        return t(($) => $.web.callback.login_failed);
      case "account_disabled":
        return t(($) => $.web.callback.account_disabled);
      case "signup_prohibited":
        return t(($) => $.web.callback.signup_prohibited);
      case "email_not_allowed":
        return t(($) => $.web.callback.email_not_allowed);
      case "google_account_no_email":
        return t(($) => $.web.callback.google_account_no_email);
      // HIBERUS: fork feature — OIDC SSO failure texts.
      case "oidc_account_no_email":
        return t(($) => $.web.callback.oidc_account_no_email);
      case "oidc_email_not_verified":
        return t(($) => $.web.callback.oidc_email_not_verified);
      case "oauth_code_invalid":
        return t(($) => $.web.callback.oauth_code_invalid);
    }
  })();

  if (desktopToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.desktop_handoff.opening_title)}
            </CardTitle>
            <CardDescription>
              {t(($) => $.web.desktop_handoff.opening_description)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = `multica://auth/callback?token=${encodeURIComponent(desktopToken)}`;
              }}
            >
              {t(($) => $.web.desktop_handoff.open_button)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error?.kind === "invalid_cli_callback") return <CliCallbackError />;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.callback.failed_title)}
            </CardTitle>
            <CardDescription>
              {errorDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <a href={paths.login()} className="text-primary underline-offset-4 hover:underline">
              {t(($) => $.web.callback.back_to_login)}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-display-sm">
            {t(($) => $.web.callback.signing_in)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
