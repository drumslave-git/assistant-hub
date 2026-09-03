# assistant-hub

A multi-user assistant platform: accounts run their own AI assistants —
personas, Telegram bots, standing tasks, tools — on one shared brain (an
OpenAI-compatible chat completions API, or a native Anthropic, Google or Z.ai
backend), with a web chat and a control/observability dashboard. Two apps: the
**core** (dashboard, web chat, the whole pipeline, one Postgres database) and a
stateless **Telegram transport** that registers with it; another messaging
platform connects the same way. Grown out of the
[ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot) MVP through a
full Next.js rewrite and the v2 redesign (see [docs/PLAN.md](docs/PLAN.md)).
Pending work is tracked in [`docs/TODO.md`](docs/TODO.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md).

| Start here | For |
| --- | --- |
| [Getting started](docs/getting-started.md) · [Configuration](docs/configuration.md) | Running it |
| [Operator guide](docs/operations/operator-guide.md) · [Troubleshooting](docs/operations/troubleshooting.md) | Operating it |
| [Using the bot in chat](docs/operations/using-the-bot.md) | The people talking to it |
| [Architecture overview](docs/architecture/overview.md) · [Contributing](docs/development/contributing.md) | Changing it |
| [Adding a transport](docs/development/adding-a-transport.md) | Connecting another messaging platform |
| [Feature docs](docs/features/README.md) | One page per feature |
| [API reference](docs/api/endpoints.md) · [`openapi.yaml`](docs/api/openapi.yaml) | Calling it |
| [Deployment](docs/operations/deployment.md) · [Backup and restore](docs/operations/backup-and-restore.md) | Shipping and keeping it |

The rest of this file is the quick reference.

## Getting Started

```bash
npm install
docker compose up -d db redis          # or point the .env files at your own Postgres + Redis
cp apps/core/.env.example apps/core/.env
cp apps/tg/.env.example apps/tg/.env   # same INTERNAL_API_TOKEN in both
npm run db:migrate
npm run dev                            # core on http://localhost:3200, Telegram service on :3210
```

## Run with Docker

```bash
docker compose up -d --build
# dashboard: http://localhost:3200  ·  health: http://localhost:3200/api/health
```

`docker compose` starts Postgres (pgvector image), Redis, the core (`app`) and
the Telegram transport (`tg`). The core container applies pending migrations
(the programmatic drizzle migrator in `packages/db/migrate/`) before it serves,
so it never runs against an unmigrated database. `DATABASE_URL` is built from
the `POSTGRES_*` vars and points at the bundled `db` service; override it to use
an external database. Set a real `INTERNAL_API_TOKEN` in a root `.env` — it is
the shared secret the two apps present to each other, and the default
`change-me` is a placeholder. Postgres persists into `./data/pg`, Redis into
`./data/redis`. Stop with `docker compose down`; to reset, delete those
directories.

## Scripts

Root scripts fan out across the workspaces through turbo.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev servers: the core on 3200 and the Telegram service on 3210 |
| `npm run build` | Production build of every workspace (`next build`, standalone output, for the core) |
| `npm run start` | Serve the core's production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run test` | Vitest unit tests (no Docker needed) |
| `npm run test:watch` | Vitest watch mode (core) |
| `npm run test:integration` | Integration tests against real Postgres and Redis (Testcontainers; **Docker required**) |
| `npm run test:linux` | The whole suite inside a Linux container (`docker-compose.test.yml`) |
| `npm run db:generate` | Generate a SQL migration from `apps/core/store/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run release:patch\|minor\|major` | Bump the root version; the release workflow ships every image on the change |

## Repository Layout

Turborepo with npm workspaces. Root `npm run lint|typecheck|test|build` fan out
across every workspace via turbo. Boundaries are intentional: `apps/*` never
import each other's code — only packages — and cross-app pointers are scoped
refs (`tg:user:123`), never foreign keys into another app's data.

| Path | Responsibility |
| --- | --- |
| `apps/core/` | The hub: dashboard, web chat, the conversation store, the reply pipeline, background jobs, LLM clients, MCP runtime, traces. One Next.js process. |
| `apps/core/app/` | App Router routes, layouts, and Route Handlers (`app/api/**/route.ts`). Handlers stay thin, declare an access level, and delegate to `server/`. |
| `apps/core/components/` | Shared, presentational dashboard UI. `components/ui/` is the design-system kit (import via `@/components/ui`); `components/layout/` the responsive app shell; `components/transports/` the schema-driven transport sections; `components/theme/` the theme toggle. |
| `apps/core/features/` | Product feature modules (server service, schemas, API, UI, tests) following the feature contract in [Contributing](docs/development/contributing.md). |
| `apps/core/server/` | Server-only domain logic and shared infrastructure: auth, ownership, the queue consumers (`ingest/`, `turn/`), the bus, LLM, MCP, jobs, trace, realtime, the conversation store (`source-store/`), transport registrations (`transports/`). |
| `apps/core/store/` | THE database module: the Drizzle schema (`schema.ts`) and the one migration chain (`migrations/`). |
| `apps/core/lib/` | Small shared utilities and pure contracts importable by both client and server. |
| `apps/core/test/` | Test support (stubs, fixtures, the Testcontainers database helper). |
| `apps/tg/` | The Telegram transport: stateless pollers that register with the core, forward every update as transport events, perform sends, and host the platform's MCP tools. The reference for [adding a transport](docs/development/adding-a-transport.md). |
| `packages/contracts/` | Cross-app zod schemas (`@assistant-hub-swarm/contracts`): scoped refs, transport events, reply delivery and turn lifecycle, the internal APIs, the trace contract, realtime topics. |
| `packages/bus/` | Redis plumbing (`@assistant-hub-swarm/bus`): BullMQ queues with `attempts: 1` and the pub/sub bus. |
| `packages/service/` | What every transport service needs once (`@assistant-hub-swarm/service`): env access, the internal-token guard, serving an MCP server over Hono, the bus trace client. |
| `packages/media/` | Image normalization to a bounded JPEG (`@assistant-hub-swarm/media`), shared by the core and the transports. |
| `packages/db/` | Shared database tooling (`@assistant-hub-swarm/db`): pool helpers, the production migration runner (`migrate/`), Testcontainers helpers (`/testing`). |
| `packages/ui/` | Shared dashboard components and the live-event hook (`@assistant-hub-swarm/ui`). |
| `packages/transport-sdk/` | The one **published** package (`@assistant-hub-swarm/transport-sdk`): the wire half of the four packages above, bundled into built output so a transport in its own repository resolves nothing private. Also generates the language-neutral wire contract in [`docs/api/transport/`](docs/api/transport/). |

### Import boundary

Server-only modules (`server/env.ts`, `server/http.ts`, …) import `server-only`
so they cannot be pulled into a client bundle. Pure contracts that the dashboard
needs to render (`lib/api-error.ts`, `lib/trace.ts`) are intentionally **not**
server-only. Path alias `@/*` maps to the `apps/core` root; workspace packages
are imported by name (`@assistant-hub-swarm/*`).

## Database

Persistence uses [Drizzle ORM](https://orm.drizzle.team) with drizzle-kit
migrations against Postgres (with the `vector` and `pg_trgm` extensions, both
created by the migrations; the compose `pgvector` image ships them).

- Edit tables in `apps/core/store/schema.ts`, then run `npm run db:generate` and
  commit the new SQL under `apps/core/store/migrations/`.
- Apply migrations with `npm run db:migrate` (drizzle-kit). In deployment the
  container entrypoint runs the same SQL through the programmatic migrator
  (`node migrate/migrate.mjs`) before starting the standalone server, so the
  core never serves against an unmigrated database.
- Ids are generated in application code.

The Telegram transport has no database: everything it needs comes from the core
at registration.

### Backups

The compose `db` service stores its data in a local bind mount, and nothing
backs it up automatically. Dump and restore with the bundled container:

```bash
# Dump (run while the db service is up; credentials default to bot/bot/bot)
docker compose exec -T db pg_dump -U bot -d bot > backup.sql

# Restore into a fresh database
docker compose exec -T db psql -U bot -d bot < backup.sql
```

The trace files under `data/traces/` are **not** in the database: they are
append-only monthly NDJSON logs holding complete LLM request/response bodies —
effectively a full chat-log archive. Back up and protect that directory with the
same care as the database dump, and do not share it casually. `data/redis/`
holds the queued (and recently processed) inbound messages; treat it the same
way. See [Backup and restore](docs/operations/backup-and-restore.md).

## Configuration

Env is bootstrap-only: `DATABASE_URL`, `REDIS_URL` and `INTERNAL_API_TOKEN` for
the core; `REDIS_URL`, `INTERNAL_API_TOKEN` and its own URLs for the Telegram
service. Every core variable also accepts a `<NAME>_FILE` Docker-secret variant.
Required values are enforced at the point of use rather than at process boot, so
the dashboard can run and report what is missing. Everything a person configures
— LLM backends and models, bot tokens, personas, tasks — lives in the database
and is edited on the dashboard. See [Configuration](docs/configuration.md).

## Dashboard authentication

The dashboard and its API are protected by **accounts** (username + password,
hashed in the database — no env credential) with two roles: **admin** (the
whole dashboard) and **user** (the web chat plus their own world: their own
assistants with bot tokens, tasks, tool connections, activity and traces,
their profile and the memory held about them). On first contact a fresh install
forces the `/setup` page, which creates the first admin; every later visit signs
in at `/login`. Sessions are signed cookies valid for 30 days, signed per
account — a password change signs out that account's other sessions and nobody
else's.

- **Set up promptly.** Until the first admin exists, the app is open — anyone
  who can reach the port can run `/setup` first and own the dashboard. Bring
  the stack up, then create the admin before exposing the port beyond
  localhost/LAN.
- **Accounts** are created by admins at `/accounts` (no open registration),
  with a temporary password the holder must replace at first sign-in. Admins
  can also deactivate/reactivate accounts, change roles, and issue a fresh
  temporary password — which is the reset path for a forgotten password.
- **A locked-out sole admin**: delete that account row in the database
  (`delete from accounts where username = '<name>'`); if it was the only
  account, the next visit re-runs `/setup` — otherwise promote a trusted
  account first (`update accounts set role = 'admin' where ...`).
- **Changing your password** is on your `/profile` (admins also under
  Settings → Security). It requires the current password.
- **Linking a chat identity** to your account: mint a one-time code on
  `/profile` and send it to any of the bots; memory and owner rights then follow
  you across the web chat and Telegram.
- `/api/health` stays public for the Docker healthcheck and orchestrators.
