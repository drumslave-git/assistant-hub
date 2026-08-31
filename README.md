# llm-tg-bot-nextjs

A Next.js rewrite of the [ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot)
MVP: a Telegram bot powered by an OpenAI-compatible chat completions API, with a
control/observability dashboard. Pending work is tracked in
[`docs/TODO.md`](docs/TODO.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md).

| Start here | For |
| --- | --- |
| [Getting started](docs/getting-started.md) · [Configuration](docs/configuration.md) | Running it |
| [Operator guide](docs/operations/operator-guide.md) · [Troubleshooting](docs/operations/troubleshooting.md) | Operating it |
| [Using the bot in chat](docs/operations/using-the-bot.md) | The people talking to it |
| [Architecture overview](docs/architecture/overview.md) · [Contributing](docs/development/contributing.md) | Changing it |
| [Feature docs](docs/features/README.md) | One page per feature |
| [API reference](docs/api/endpoints.md) · [`openapi.yaml`](docs/api/openapi.yaml) | Calling it |
| [Deployment](docs/operations/deployment.md) · [Backup and restore](docs/operations/backup-and-restore.md) | Shipping and keeping it |

The rest of this file is the quick reference.

## Getting Started

```bash
npm install
cp .env.example .env   # then fill in required values
npm run dev            # http://localhost:3200
```

## Run with Docker

```bash
cp .env.example .env   # optional; compose has sane defaults for DB
docker compose up -d --build
# dashboard: http://localhost:3200  ·  health: http://localhost:3200/api/health
```

`docker compose` starts Postgres (pgvector image) and the app. The app container
applies pending migrations (`drizzle-kit migrate`) before serving, so it never
runs against an unmigrated database. `DATABASE_URL` is built from the `POSTGRES_*`
vars and points at the bundled `db` service; override it to use an external
database. Postgres persists into a bind-mounted host directory (`./data/pg`,
default `./data/pg`). Stop with `docker compose down`; to reset the database,
delete that directory.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 3200 |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests (no Docker needed) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:integration` | DB integration tests against real Postgres (Testcontainers; **Docker required**) |
| `npm run db:generate` | Generate a SQL migration from `apps/core/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |

## Repository Layout

Turborepo with npm workspaces (the v2 redesign scaffold — see
[docs/PLAN.md](docs/PLAN.md)). Root `npm run lint|typecheck|test|build` fan out
across every workspace via turbo. Boundaries are intentional; keep
feature-specific plumbing out of shared modules, and `apps/*` never import each
other's code — only packages.

| Path | Responsibility |
| --- | --- |
| `apps/core/` | The hub app (dashboard + pipeline + bot, one Next.js process). Everything below is relative to it. |
| `apps/core/app/` | App Router routes, layouts, and Route Handlers (`app/api/**/route.ts`). Handlers stay thin and delegate to `server/`. |
| `apps/core/components/` | Shared, presentational dashboard UI (no feature business logic). `components/ui/` is the design-system kit (import via `@/components/ui`); `components/layout/` is the responsive app shell (sidebar/drawer/topbar, nav config, extension registry); `components/theme/` holds the theme toggle + pre-hydration script. |
| `apps/core/features/` | Product feature modules (server service, schemas, API, UI, tests) following the feature contract in [Contributing](docs/development/contributing.md). |
| `apps/core/server/` | Server-only domain logic and shared infrastructure. Modules that touch secrets, DB, filesystem, Telegram, or the LLM provider import `server-only`. |
| `apps/core/db/` | This app's Drizzle schema (`schema.ts`), generated SQL migrations (`migrations/`), and pooled Drizzle handle (`getDb()`). |
| `apps/core/lib/` | Small shared utilities and pure contracts (error shape, trace types) importable by both client and server. |
| `apps/core/test/` | Test support (stubs, fixtures). |
| `apps/core/store/` | The v2 core-store database module (schema, migrations, v1 import) — the redesign's brain store, beside the v1 `db/` until cutover. |
| `apps/tg/` | Telegram transport: stateless pollers that register with the core, forward updates as transport events, perform sends, and host the platform's MCP tools. |
| `packages/db/` | Shared database tooling (`@assistant-hub/db`): pg pool singletons, the production migration runner (`migrate/`), v1-split import plumbing (`/import`), and Testcontainers helpers (`/testing`). Each app defines its own schema and migration chain on top of this. |
| `packages/contracts/` | Cross-app zod schemas (`@assistant-hub/contracts`): the source-app contract, scoped refs, bus/queue payloads — populated by the redesign phases. |
| `packages/ui/` | Shared dashboard components + the typed extension-point registry (`@assistant-hub/ui`) the shell composes from. |

### Import boundary

Server-only modules (`server/env.ts`, `server/http.ts`, …) import `server-only`
so they cannot be pulled into a client bundle. Pure contracts that the dashboard
needs to render (`lib/api-error.ts`, `lib/trace.ts`) are intentionally **not**
server-only. Path alias `@/*` maps to the `apps/core` root; workspace packages
are imported by name (`@assistant-hub/*`).

## Database

Persistence uses [Drizzle ORM](https://orm.drizzle.team) with drizzle-kit
migrations against Postgres.

- Edit tables in `apps/core/db/schema.ts`, then run `npm run db:generate` and
  commit the new SQL under `apps/core/db/migrations/`.
- Apply migrations with `npm run db:migrate` (drizzle-kit). In deployment this
  same command runs as the container entrypoint step before `next start`, so the
  app never serves against an unmigrated database.
- Ids are generated in application code, so no Postgres extensions are required
  for the shared schema.

### Backups

The compose `db` service stores its data in a local bind mount, and nothing
backs it up automatically. Dump and restore with the bundled container:

```bash
# Dump (run while the db service is up; credentials default to bot/bot/bot)
docker compose exec -T db pg_dump -U bot -d bot > backup.sql

# Restore into a fresh database
docker compose exec -T db psql -U bot -d bot < backup.sql
```

The trace files under `data/traces/` are **not** in the database:
they are append-only monthly NDJSON logs holding complete LLM request/response
bodies — effectively a full chat-log archive. Back up and protect that directory
with the same care as the database dump, and do not share it casually.

## Configuration

All environment variables are documented in `.env.example`. Every variable also
accepts a `<NAME>_FILE` Docker-secret variant. Required values are enforced at
the point of use (`requireEnv`) rather than at process boot, so the dashboard can
run and report what is missing.

## Dashboard authentication

The dashboard and its API are protected by **accounts** (username + password,
hashed in the database — no env credential) with two roles: **admin** (the
whole dashboard) and **user** (the web chat plus their own world: their own
assistants with bot tokens, tasks, tool connections, activity and traces,
their profile and the memory held about them). On
first contact a fresh install forces the `/setup` page, which creates the
first admin; every later visit signs in at `/login`. Sessions are signed
cookies valid for 30 days, signed per account — a password change signs out
that account's other sessions and nobody else's.

- **Set up promptly.** Until the first admin exists, the app is open — anyone
  who can reach the port can run `/setup` first and own the dashboard. Bring
  the stack up, then create the admin before exposing the port beyond
  localhost/LAN.
- **Accounts** are created by admins at `/accounts` (no open registration),
  with a temporary password the holder must replace at first sign-in. Admins
  can also deactivate/reactivate accounts, change roles, and issue a fresh
  temporary password — which is the reset path for a forgotten password.
- **A locked-out sole admin**: delete that account row in the database
  (`delete from accounts where username = '<name>'` on the core store); if it
  was the only account, the next visit re-runs `/setup` — otherwise promote a
  trusted account first (`update accounts set role = 'admin' where ...`).
- **Changing your password** is on your `/profile` (admins also under
  Settings → Security). It requires the current password.
- `/api/health` stays public for the Docker healthcheck and orchestrators.
