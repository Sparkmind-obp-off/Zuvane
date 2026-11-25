# ZUVANE

**Work, orchestrated. People, in control.**

ZUVANE is an independent Agentic Workspace for individuals and teams. It coordinates AI work while keeping consequential actions bounded by explicit human authority.

## Current application slice

The repository includes a full-stack workspace foundation:
- Responsive workspace dashboard and ZUVANE design system.
- Clerk sign-in UI and verified session authentication at the Worker boundary.
- User-scoped task creation, task lists, guarded status transitions, and approval queue.
- Cloudflare Worker API and versioned D1 schema migrations.
- Deterministic domain logic, RS256/JWKS verification tests, and GitHub Actions CI.

This is an **authenticated personal-workspace vertical slice**, not a finished production agent platform. Team membership, organization RBAC, live agent execution, model integrations, external tool execution, and production deployment are not yet enabled.

## Product principles

- **Human control:** approvals and policy boundaries precede consequential execution.
- **Provider-neutral:** models and tools are adapters, not the product identity.
- **Observable work:** agent identity, scope, state, outputs, and evidence are inspectable.
- **Auditable actions:** decisions and execution events should leave traceable records.
- **Deterministic orchestration:** workflow state and policy remain deterministic around probabilistic model outputs.

## Brand

- Positioning: The human-controlled workspace for coordinated AI work.
- Tagline: Work, orchestrated. People, in control.
- Colors: Void `#0C1118`, Signal Teal `#53D6C2`, Mist `#EAF0F4`.
- Typography: Manrope, Inter, IBM Plex Mono.

## Repository map

- `public/` — responsive workspace UI, Clerk auth surface, and brand assets
- `worker/` — Cloudflare Worker API and auth boundary
- `src/auth/` — provider-specific Clerk JWT verification
- `src/domain/` — provider-neutral task and approval rules
- `test/` — automated tests
- `migrations/` — D1 schema migrations
- `docs/security/` — authentication and ownership contract
- `docs/brand/` — strategy and identity standards
- `docs/design/` — design tokens and usage guidance

## Local development

Requires Node.js 22+.

```bash
npm install
npx wrangler d1 migrations apply zuvane-local --local
npm run dev
```

Run checks:

```bash
npm run check
```

The local Wrangler config uses the existing Clerk development instance. Production requires the production Clerk variables and an actual D1 database ID; see [Clerk authentication](docs/security/clerk-authentication.md). The D1 identifier in `wrangler.toml` is a local placeholder. No production Cloudflare resources are created or activated by this repository. Production provisioning requires a separate cost/access review and explicit approval.

## License

No license has been declared. All rights are reserved unless a license is added.
