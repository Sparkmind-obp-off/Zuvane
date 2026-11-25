# Clerk authentication and workspace ownership

## Runtime contract

- The browser fetches a **publishable key** and frontend API URL from `GET /api/config`; these values are public by design. No Clerk secret key is stored in browser code or Git.
- The browser loads the Clerk UI and JavaScript SDK from the matching Clerk Frontend API domain and passes short-lived session tokens as `Authorization: Bearer <token>`.
- The Cloudflare Worker verifies RS256 signatures against the configured Clerk instance JWKS, checks `iss`, `exp`, `nbf`, `sub`, and the `azp` authorized party.
- Set `CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API_URL`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` for the same Clerk instance. `CLERK_AUTHORIZED_PARTIES` is an optional comma-separated list of exact frontend origins. When omitted, the request origin is the only permitted `azp`.
- Every task and approval query is scoped to the authenticated Clerk user ID. A user cannot read, update, approve, or request approval for another user's task.
- `/api/health` and `/api/config` are intentionally public; the latter returns only public Clerk frontend configuration.

## Existing Clerk setup observed

The connected Clerk workspace contains an existing application with development and production instances. Google OAuth is enabled in both. This implementation reuses the existing app without changing live Clerk settings. The production Frontend API domain encoded in its publishable key is `clerk.zuvane.biz.id`. No secret key is committed.

## Local development

The checked-in `wrangler.toml` uses the existing Clerk development publishable key and development Frontend API domain. Apply migrations locally:

```bash
npx wrangler d1 migrations apply zuvane-local --local
npm run dev
```

## Production configuration (deployed)

`wrangler.toml` `[env.production]` is bound to the existing Clerk Production instance:

- `CLERK_PUBLISHABLE_KEY`: production publishable key (public).
- `CLERK_FRONTEND_API_URL` / `CLERK_ISSUER`: `https://clerk.zuvane.biz.id`.
- `CLERK_JWKS_URL`: `https://clerk.zuvane.biz.id/.well-known/jwks.json`.
- `CLERK_AUTHORIZED_PARTIES`: `https://zuvane.biz.id`.
- `CLERK_SECRET_KEY`: Worker **secret** (never committed). It is used only to read a user's own name/email from the Clerk Backend API at most once every 24 h.

Clerk Production was inspected read-only: environment `production`, domain `zuvane.biz.id`, Google OAuth is the only sign-in strategy, single-session mode, and all Clerk DNS records are present in the Cloudflare zone. No Clerk settings were changed.

## Security limitations

- Workspaces, memberships and roles (owner/admin/member/viewer) are implemented in ZUVANE itself, not with Clerk Organizations. Members are added by email after they have signed in once; email invitations are not implemented.
- Task rows from before migration `0002` with `owner_id = NULL` remain inaccessible. Rows that have an owner are adopted into that owner's personal workspace on first sign-in.
- Configure MFA and sign-up restrictions in Clerk separately after product access policy is decided. This code does not change Clerk Dashboard settings.
- JWKS keys are cached in Worker isolate memory for five minutes. A cold isolate fetches the JWKS endpoint again.
