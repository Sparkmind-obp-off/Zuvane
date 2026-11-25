# ZUVANE MVP Runtime

## Scope of this slice
v0.3.0 adds workspaces and RBAC, an agent registry, a bounded orchestration engine, an approval center tied to runs, a tool gateway with mock adapters, and an audit trail. See README.md for the full API.

## Architecture
- **Web UI:** static, responsive HTML/CSS/JavaScript served by Cloudflare Workers Static Assets.
- **API:** Cloudflare Worker routes under `/api/*`.
- **Persistence:** Cloudflare D1 using versioned SQL migrations.
- **Domain logic:** provider-independent pure JavaScript functions in `src/domain`.
- **Tests:** Node's built-in test runner; no paid service required.

## Trust boundaries
- The browser is an untrusted client.
- The Worker validates all incoming task and approval payloads.
- State transitions are allowlisted in deterministic domain logic.
- Approval decisions are explicit human actions.
- Only the deterministic mock provider and mock tool adapters are enabled. No external model, email, calendar, browser or terminal is ever contacted.

## API
- `GET /api/health`
- `GET /api/tasks`
- `POST /api/tasks`
- `PATCH /api/tasks/:id/status`
- `GET /api/approvals`
- `POST /api/approvals`
- `POST /api/approvals/:id/decision`

## Local development
1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Apply the local D1 migration: `npx wrangler d1 migrations apply zuvane-local --local`.
4. Start the Worker: `npm run dev`.
5. Open the local URL printed by Wrangler.
6. Run tests with `npm test` or `npm run check`.

The D1 ID in `wrangler.toml` is a local-development placeholder. Before production deployment, create a D1 database only after explicit approval, replace the ID with the actual database ID, and configure the production migration. No Cloudflare resource is created by this repository change.

## Next milestones
1. Authentication and workspace membership.
2. Agent registry, role/scope contracts, and model-provider adapters.
3. Bounded orchestration state machine and event log.
4. Tool registry with read/draft defaults and approval-required writes.
5. Audit timeline, retry/idempotency, and evaluation suite.
6. Deployment and production hardening after cost review.
