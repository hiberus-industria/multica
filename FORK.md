# Fork guide

This repository is Hiberus' private fork of [multica-ai/multica](https://github.com/multica-ai/multica) (`upstream`). We track upstream closely and keep our own changes small, additive, and cheap to re-apply on every sync.

## Layout

| Remote | Repository | Role |
| --- | --- | --- |
| `origin` | `hiberus-industria/multica` (private) | Our fork; `main` is our integration branch |
| `upstream` | `multica-ai/multica` | The open-source project we track |

`main` = upstream `main` + our commits. Fork feature branches are named `hiberus/<topic>` (e.g. `hiberus/oidc-sso`) and merge into `main` via PR.

## Upstream sync protocol

Run roughly monthly or per upstream release:

1. `git fetch upstream`
2. `git merge upstream/main`
3. Resolve conflicts. Our surface is small by design: review the [touched upstream files](#touched-upstream-files) first; anything else that conflicts is a breach of the isolation rules below.
4. Verify: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `make test`, and `make check` for the combined pass. Use `make up` and the worktree scripts documented in `CONTRIBUTING.md`.
5. `git push origin main`.

Rules:

- Merge, never rebase: `main` history is append-only; no force-pushes.
- Never push upstream tags to `origin` — tag pushes trigger upstream release workflows (`release.yml`, GoReleaser) that must not run on the fork.
- Upstream workflows that need Multica Cloud secrets (release, promote, desktop smoke) may fail on the fork; that noise is expected. Do not fix them here; disable the workflow on GitHub if it becomes a problem.

## Isolation conventions

1. Prefer new files over editing upstream files. Fork-owned code lives beside upstream code under the same packages (same import rules) in clearly named new files.
2. Every unavoidable touch to an upstream file is minimal, additive, and marked with a `HIBERUS:` comment (language-appropriate syntax: `// HIBERUS:`, `# HIBERUS:`, `-- HIBERUS:`) with a one-line reason.
3. No Hiberus-specific names, URLs, or secrets in code. Fork behavior is config-driven through env vars so the code stays generic.
4. Fork-only documentation lives in this file; do not edit upstream docs for fork-only behavior.
5. Tests for fork behavior live in new test files beside the fork code, following the repo's testing rules in `AGENTS.md`.

## Touched upstream files

This registry is the authoritative conflict-review list for every sync. Update it in the same change that adds a touch.

| File | Touch | Reason |
| --- | --- | --- |
| `server/internal/auth/cookie.go` | +6 lines (exported `SecureCookie`) | OIDC flow cookie reuses the deployment's Secure derivation instead of re-deriving it |
| `server/internal/handler/auth.go` | 3 gate checks (4 lines each) | SSO gate on SendCode/VerifyCode/GoogleLogin (see `sso_gate.go`) |
| `server/internal/handler/config.go` | 2 lines | Expose the public `oidc` block on `/api/config` |
| `server/cmd/server/router.go` | 2 lines | Mount `GET /auth/oidc/start` and `POST /auth/oidc` |
| `packages/core/api/schemas.ts` | interface field + zod field | Parse the additive `oidc` block from `/api/config` |
| `packages/core/api/client.ts` | 1 method | `oidcLogin` exchange call |
| `packages/core/auth/store.ts` | 1 action + 1 type | `loginWithOidc` mirrors `loginWithGoogle` |
| `packages/core/config/index.ts` | field + setter plumbing | Carry the public SSO config to the login UIs |
| `packages/core/platform/auth-initializer.tsx` | 2 lines | Forward `cfg.oidc` into the config store |
| `packages/views/auth/login-page.tsx` | prop + SSO-only branch | SSO button, break-glass fallback toggle |
| `apps/web/app/(auth)/login/page.tsx` | wiring (~15 lines) | Build `/auth/oidc/start` URL with the packed state |
| `apps/web/app/auth/callback/page.tsx` | branch + error cases (~20 lines) | `sso` state marker selects the OIDC exchange |
| `apps/web/app/auth/callback/callback-error.ts` | 2 error kinds | SSO-specific failure texts |
| `apps/desktop/src/renderer/src/pages/login.tsx` | SSO button via system browser | Desktop SSO without an in-app OIDC client |
| `packages/views/locales/*/auth.json` (×8) | 4 keys each | `signin.sso`, `web.sso_fallback`, 2 SSO callback errors |

Everything else in the SSO feature lives in fork-owned files: `server/internal/handler/oidc.go`, `server/internal/handler/sso_gate.go`, and their `*_test.go` files.

## History

- 2026-11-17: fork re-established from upstream `main` (`6fc64f22`). The previous `hiberus-industria/multica` repo (an earlier fork attempt; its `main` carried 97 commits not in upstream) was deleted on GitHub because its recurring upstream conflicts were the problem this structure exists to avoid. A local backup of its branches remains in `refs/old-fork/heads/*` of a developer clone; porting any of that work is a fresh decision, not an inheritance.

## Fork-owned infrastructure

- `docker/keycloak/` — local Keycloak (realm `devhi`, client `multica-web`) for
  SSO development and manual verification. Start with
  `docker compose -f docker/keycloak/docker-compose.yml up -d`. The dev API is
  pointed at it with `OIDC_ENABLED=true`, `OIDC_ISSUER=http://localhost:8081/realms/devhi`,
  `OIDC_CLIENT_ID=multica-web`, `OIDC_CLIENT_SECRET=multica-web-local-secret`.

## Roadmap

1. **SSO OIDC/Keycloak (phase 1)**: instance-wide OIDC login configured via `OIDC_*` env vars, just-in-time user creation by email, Keycloak realm as the access boundary, OTP/Google login blocked server-side with a break-glass exception for `ALLOWED_EMAILS`. Mobile keeps its current login flow.
2. **Phase 2**: mobile OIDC via system browser; only then close OTP for everyone.
3. Later options: back-channel logout, group-to-workspace mapping.
