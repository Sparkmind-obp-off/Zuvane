# ZUVANE

**Work, orchestrated. People, in control.**

ZUVANE is an independent Agentic Workspace: a human-controlled workspace for orchestrating tasks, AI agents, tools and workflows. Agents only act within explicit capabilities, tool permissions and execution limits, and consequential actions pause for human approval.

## Status (v0.3.0)

| Area | State |
|---|---|
| Production URL | https://zuvane.biz.id (Cloudflare Worker custom domain) |
| Health | https://zuvane.biz.id/api/health |
| Identity | Clerk **Production** instance (`clerk.zuvane.biz.id`, Google OAuth only) |
| Database | Cloudflare D1 `zuvane-production` (migrations 0001–0003 applied) |
| Model provider | Deterministic **mock** provider only (no external AI calls, no cost) |
| Tool adapters | **Mock** adapters only — every result is marked `simulated: true` |

Not yet verified: an interactive Google sign-in on production. Clerk Production does not allow backend-created sessions, so this needs one manual sign-in.

## Implemented features

- **Authentication** — Clerk sign-in/sign-up (Google), sign-out, session renewal through the Clerk SDK, and handling for expired sessions. Every API call is verified in the Worker: RS256 signature checked against the Clerk JWKS, plus `iss`, `exp`, `nbf`, `azp` and `sub`. Verification fails closed (503) if its configuration is missing.
- **Workspaces & RBAC** — Each user gets a personal workspace automatically. Team workspaces support `owner`/`admin`/`member`/`viewer` roles, enforced on the server. Non-members get 404 (no existence disclosure), and the last owner cannot be removed or demoted.
- **Tasks** — Create and edit tasks, set a required capability, and move them through a guarded lifecycle (`planned → in_progress → needs_approval/completed/blocked`).
- **Agent Control Center** — Agent registry with type, provider/model, capabilities, allowed tools, max steps, timeout and retries. Agents start as `draft` with **no tools**. Lifecycle: `draft/active/paused/disabled/error`.
- **Orchestration engine** — Deterministic agent selection by capability. Runs are bounded by step budget, timeout and retry limit; there are no background jobs and no recursion. Run states: `queued → assigned → running → waiting_approval → completed/failed/cancelled`. Every step is recorded.
- **Approval Center** — Records the requester, risk level, parameter summary, expiry (72 h), decision maker, note and execution result. Approve, reject, cancel and expire are all supported. Approving resumes the paused run on the server.
- **Provider & Tool Gateway** — Provider-neutral adapter interfaces. A tool needs (a) explicit agent permission, (b) a connected integration, (c) the per-connection rate limit, and (d) approval: medium/high-risk tools always require it, low-risk tools follow the connection's policy.
- **Audit & observability** — Append-only `audit_events` (with secrets redacted), correlation IDs on every response, structured JSON logs, usage records, and a log of rejected-auth attempts.
- **Security** — Parameterized SQL, input validation, JSON body size cap, rate limits stored in D1, an origin check on writes (CSRF defence), CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`.
- **Frontend** — SPA with 8 sections (Overview, Tasks, Approvals, Agents, Runs, Integrations, Activity, Settings) plus task/agent/run detail pages. Includes a workspace switcher, skeleton loading, empty/error/retry states, confirmation dialogs, responsive layout (off-canvas nav under 900px), skip link, keyboard focus styles and reduced-motion support.

## API (all under `/api`, Bearer Clerk session token)

Public: `GET /health`, `GET /config`.

Authenticated: `GET /me`, `GET /catalog`, `POST /workspaces`.

Workspace-scoped (`/workspaces/:ws`):

| Resource | Endpoints |
|---|---|
| Workspace | `GET`, `PATCH`, `GET /overview` |
| Members | `GET /members`, `POST /members`, `PATCH /members/:userId`, `DELETE /members/:userId` |
| Tasks | `GET /tasks?status=`, `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `PATCH /tasks/:id/status` |
| Approvals | `GET /approvals?status=`, `POST /approvals`, `POST /approvals/:id/decision`, `POST /approvals/:id/cancel` |
| Agents | `GET /agents`, `POST /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `POST /agents/:id/status` |
| Runs | `GET /runs?status=`, `POST /runs`, `GET /runs/:id`, `POST /runs/:id/cancel` |
| Integrations | `GET /integrations`, `POST /integrations`, `PATCH /integrations/:id` |
| Activity | `GET /activity?limit=&before=` |

Errors use `{ error, code, correlation_id, details? }`.

## Data model (D1)

`users`, `workspaces`, `workspace_members`, `tasks`, `agents`, `agent_runs`, `run_steps`, `approvals`, `tool_connections`, `audit_events`, `usage_records`, `rate_limits` — see `migrations/`. Migration 0003 rebuilds `approvals` and preserves existing rows. Rows owned by a user before 0003 are adopted into that user's personal workspace on first sign-in.

## Repository map

- `worker/index.js` — Worker entry, routing, auth boundary, security headers
- `src/auth/clerk.js` — Clerk JWT/JWKS verification
- `src/api/routes.js` — workspace-scoped handlers
- `src/domain/` — tasks, RBAC, agents, run state machine
- `src/orchestration/` — engine, providers (mock), tool gateway (mock adapters)
- `src/services/` — identity provisioning, audit, rate limiting
- `public/` — SPA (HTML/CSS/JS) and brand assets
- `test/` — 41 tests (real migrations on `node:sqlite`, real RS256-signed tokens)

## Development

Requires Node.js ≥ 22.5.

```bash
npm ci
npm run db:migrate:local
npx wrangler dev            # local: Clerk development instance
npm run check               # syntax + all tests
```

## Production deployment (Cloudflare, user account)

```bash
npm run db:migrate:prod     # apply new migrations to zuvane-production
npm run deploy:prod         # runs checks, then wrangler deploy --env production
# one-time: wrangler secret put CLERK_SECRET_KEY --env production
```

Rollback: `npx wrangler rollback --env production` (Worker versions). Migrations only add to the schema; take a backup with `wrangler d1 export zuvane-production --remote --env production` before applying a new one.

Cost: Workers Free + D1 Free + Free-plan zone. No paid resources were created.

## License

No license has been declared. All rights are reserved.
