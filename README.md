# ZUVANE

**Work, orchestrated. People, in control.**

ZUVANE is an independent Agentic Workspace for individuals and teams. It coordinates multi-agent work across hybrid infrastructure while keeping consequential actions bounded by explicit human authority.

## Current application slice

The repository now includes a runnable full-stack MVP foundation:
- Responsive workspace dashboard and ZUVANE design system.
- Task creation, task list, priorities, and guarded status transitions.
- Human approval queue for consequential task actions.
- Cloudflare Worker API and D1 schema/migration.
- Deterministic domain logic with Node.js tests.
- GitHub Actions CI for syntax and unit-test checks.

This is a **first vertical slice**, not a finished production agent platform. Authentication, team membership, live agents, model integrations, external tool execution, and production deployment are not yet enabled.

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

- `public/` — responsive workspace UI and brand assets
- `worker/` — Cloudflare Worker API
- `src/domain/` — provider-neutral task and approval rules
- `test/` — automated tests
- `migrations/` — D1 schema migrations
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

The D1 identifier in `wrangler.toml` is a local placeholder. No production Cloudflare resources are created or activated by this repository. Production provisioning requires a separate cost/access review and explicit approval.

## License

No license has been declared. All rights are reserved unless a license is added.
