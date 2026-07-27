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
database. Postgres persists into a bind-mounted host directory (`PG_DATA_DIR`,
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
| `npm run db:generate` | Generate a SQL migration from `db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |

## Repository Layout

Boundaries are intentional; keep feature-specific plumbing out of shared modules.

| Path | Responsibility |
| --- | --- |
| `app/` | App Router routes, layouts, and Route Handlers (`app/api/**/route.ts`). Handlers stay thin and delegate to `server/`. |
| `components/` | Shared, presentational dashboard UI (no feature business logic). `components/ui/` is the design-system kit (import via `@/components/ui`); `components/layout/` is the responsive app shell (sidebar/drawer/topbar, nav config); `components/theme/` holds the theme toggle + pre-hydration script. |
| `features/` | Product feature modules (server service, schemas, API, UI, tests) following the feature contract in [Contributing](docs/development/contributing.md). |
| `server/` | Server-only domain logic and shared infrastructure. Modules that touch secrets, DB, filesystem, Telegram, or the LLM provider import `server-only`. |
| `db/` | Drizzle schema (`schema.ts`), generated SQL migrations (`migrations/`), pooled Drizzle handle (`getDb()`), and the migrator. |
| `lib/` | Small shared utilities and pure contracts (error shape, trace types) importable by both client and server. |
| `test/` | Test support (stubs, fixtures). |

### Import boundary

Server-only modules (`server/env.ts`, `server/http.ts`, …) import `server-only`
so they cannot be pulled into a client bundle. Pure contracts that the dashboard
needs to render (`lib/api-error.ts`, `lib/trace.ts`) are intentionally **not**
server-only. Path alias `@/*` maps to the repo root.

## Database

Persistence uses [Drizzle ORM](https://orm.drizzle.team) with drizzle-kit
migrations against Postgres.

- Edit tables in `db/schema.ts`, then run `npm run db:generate` and commit the
  new SQL under `db/migrations/`.
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

The trace files under `data/traces/` (`TRACES_DIR`) are **not** in the database:
they are append-only monthly NDJSON logs holding complete LLM request/response
bodies — effectively a full chat-log archive. Back up and protect that directory
with the same care as the database dump, and do not share it casually.

## Configuration

All environment variables are documented in `.env.example`. Every variable also
accepts a `<NAME>_FILE` Docker-secret variant. Required values are enforced at
the point of use (`requireEnv`) rather than at process boot, so the dashboard can
run and report what is missing.

## Dashboard authentication

The dashboard and its API are protected by a single operator password, stored
**hashed in the database** (no env credential). On first contact a fresh
install forces the `/setup` page, where the password is chosen; every later
visit signs in at `/login`. Sessions are signed cookies valid for 30 days; the
Sign out button in the top bar ends one.

- **Set up promptly.** Until the password is set, the app is open — anyone who
  can reach the port can run `/setup` first and own the dashboard. Bring the
  stack up, then visit it and set the password before exposing the port beyond
  localhost/LAN.
- **Forgot the password?** Clear it in the database and run setup again:

  ```sh
  docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "update settings set operator_password_hash = null, session_secret = null"
  ```

  Restart is not required; the next dashboard visit redirects to `/setup`.
- **Changing the password** is the same procedure (there is deliberately no
  authenticated change-password flow yet). Rotating it invalidates every
  session.
- `/api/health` stays public for the Docker healthcheck and orchestrators.
