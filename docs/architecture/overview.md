# Architecture overview

One Next.js 16 App Router application, one Postgres database, one process. The
Telegram poller, the background schedulers, the MCP tool server, the realtime hub
and the trace store all run **inside** the Next.js server process. That is a
recorded decision, not an accident: this app is designed to be self-hosted as a
single container.

```
                    Telegram (long polling, @grammyjs/runner)
                                    │
                            server/telegram/
                        bot-manager → transport
                                    │
   dashboard ──HTTP──► app/api/**  ─┼─► server/telegram/process-update.ts
   (browser)  ◄──SSE── /api/events  │        (transport-agnostic pipeline)
                                    ▼
                          features/*/server/*  (services)
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
        db/ (Drizzle,        server/trace/          server/llm/ + server/mcp/
        Postgres)            (NDJSON files)         (OpenAI-compatible + tools)
```

## Layers

| Directory | Responsibility | Rules |
| --- | --- | --- |
| `app/` | App Router routes, layouts, Route Handlers (`app/api/**/route.ts`) | Handlers stay thin: declare schemas, delegate to a service |
| `components/` | Shared presentational dashboard UI | No feature business logic. `components/ui/` is the design kit, `components/layout/` the app shell, `components/debug/` the shared Debug views |
| `features/` | One directory per product feature: pure logic at the root, `server/` for services, `ui/` for its components | Follows the feature contract (see [Contributing](../development/contributing.md)) |
| `server/` | Server-only domain infrastructure: auth, HTTP wrappers, LLM clients, MCP, jobs, trace, realtime, Telegram edge, media | Modules touching secrets, DB, filesystem, Telegram or the LLM import `server-only` |
| `db/` | Drizzle schema, generated SQL migrations, the pooled handle | `getDb()` returns the process-wide pool |
| `lib/` | Small shared contracts importable from **both** client and server | Pure. No `server-only`, no DB, no secrets |
| `test/` | Stubs, fixtures, DB helper, the bot-less simulation harness | — |

Path alias: `@/*` maps to the repo root.

### The import boundary

The boundary is enforced by the `server-only` package rather than by convention.
`server/env.ts`, `server/http.ts`, every repository and every service import it,
so pulling one into a client bundle is a build error.

Pure contracts the dashboard must render — `lib/api-error.ts`, `lib/trace.ts`,
`lib/realtime.ts`, `lib/features.ts`, `lib/format.ts`, `lib/language.ts`,
`lib/embeddings.ts` — are intentionally **not** server-only. Feature `types.ts`
and pure `format.ts` modules follow the same rule: a Client Component can import
them, so a `server-only` import there would break the dashboard.

Under Vitest, `server-only` is aliased to an empty stub (`test/stubs/empty.ts`)
so server modules can be unit-tested directly.

## The feature module shape

Every feature is laid out the same way, which is what makes the codebase
navigable:

```
features/<name>/
  types.ts            client-safe shared types
  format.ts           pure presentation / prompt-text shaping
  <pure>.ts           pure decision logic (+ .test.ts beside it)
  server/
    schema.ts         zod validation contract (shared by service, routes, UI)
    repository.ts     typed persistence — pure data access, takes a DrizzleDb
    service.ts        the boundary: policy, validation, tracing
    scheduler.ts      background wiring, when the feature has a job
    mcp-tools.ts      the feature's MCP tools, when it exposes any
    *.integration.test.ts
  ui/
    *.tsx             the feature's dashboard components
```

The separation is strict on purpose: repositories hold no policy and no tracing,
services hold no SQL, and route handlers hold neither. A repository takes a
`DrizzleDb` argument so the same code runs against the production pool and
against a Testcontainers instance.

## Request lifecycle (dashboard API)

1. `proxy.ts` (Next 16's renamed middleware convention) does an **optimistic**
   redirect: no session cookie present → `/login`. It cannot verify the cookie,
   because verification needs the DB-stored secret.
2. `defineRoute` (`server/http.ts`) wraps the handler: it calls
   `requireOperator(request)` unless `auth: false`, awaits the dynamic route
   params, runs the body, and maps any thrown value to the shared error envelope.
3. The body parses input with a zod schema (`parseJson`, `parseQuery`,
   `readJsonBody`) and calls a service.
4. The service validates policy, does its work through a repository, records a
   trace, publishes a realtime event, and returns a client-safe shape.
5. `ok(data)` wraps the result as `{ data }`; `jsonDownload` / `csvDownload`
   produce attachments instead.

The only public routes are the three auth endpoints and `/api/health`. Auth is
enforced at *both* the proxy and `defineRoute`, so the API stays covered even
when the proxy is bypassed.

## Request lifecycle (dashboard pages)

Pages are Server Components that call services directly — no internal fetch. The
real page-side auth gate is `app/(dashboard)/layout.tsx`, which verifies the
cookie signature against the DB secret before rendering anything, sending bare
visitors to `/login` and a fresh install to `/setup`. `app/layout.tsx` is a bare
document shell so `/login` and `/setup` render without app chrome and without any
data the operator has not signed in to see.

Interactivity is pushed to leaf Client Components. Data stays server-rendered and
is kept fresh over SSE — see [Observability](observability.md#live-updates).

## Process singletons

Several things must exist exactly once per process and must survive Next's bundle
re-evaluation and dev hot-reload. Each is held on a `globalThis` slot keyed by a
`Symbol.for(...)`, because a module-local would be re-created per bundle copy:

| Singleton | Module | Why it must be single |
| --- | --- | --- |
| Postgres pool | `db/pool.ts` | A module-local leaks connections on every hot reload |
| Telegram bot manager | `server/telegram/bot-manager.ts` | Telegram permits exactly one `getUpdates` consumer per token |
| MCP registry | `server/mcp/runtime.ts` | Tools are registered once; the in-process client/server pair connects once |
| Realtime hub | `server/realtime/hub.ts` | One pub/sub bus shared by publishers and the SSE route |
| Trace store | `server/trace/store.ts` | Writers and the boot-owned flush timer must share one instance |
| Shared Chromium | `features/link-fetch/server/playwright.ts` | Launching costs ~1s; a per-module copy leaks browser processes |
| Adblock engine | `features/link-fetch/server/adblock.ts` | One prebuilt filter engine per process |
| Each scheduler | `server/jobs/*`, per job name | Exactly one ticker per job |
| Browser-run live state | `features/browser-agent/server/live-state.ts` | Ephemeral per-run progress, deliberately not persisted |
| Insight scan floor | `features/analytics/server/watermark.ts` | Process-local lower bound for the due-scan |

The consequence: this is a **single-instance** design. Scaling to multiple
replicas would need an external fan-out behind the realtime hub's API
(e.g. Postgres `LISTEN`/`NOTIFY`) and an external trace store behind the store's
API. Cross-process *job* overlap is already handled — see
[Background jobs](background-jobs.md#advisory-locks).

## Boot sequence

`instrumentation.ts` → `register()` runs once per server instance. It returns
immediately unless `NEXT_RUNTIME === "nodejs"`, then dynamically imports
`server/telegram/register-node.ts` — the split keeps Node-only `process` APIs out
of the Edge-analyzed instrumentation module.

`registerNode()` then, in order:

1. Registers `SIGTERM`/`SIGINT` handlers that stop every scheduler, flush the
   trace store, stop the bot (with a 3s cap), and exit.
2. Arms the trace store: warms the current month from disk and starts the
   periodic flush.
3. Starts the six schedulers: vision backfill (idle), scheduled tasks
   (interval), self-improvement, history summaries, memory, analytics (all
   daily).
4. Starts the browser-agent runner, which first sweeps any run left `running` by
   a previous process to `failed`, then drains the queue.
5. Fire-and-forget starts the Telegram poller and logs the outcome.

Nothing here gates readiness. A missing token, an unreachable LLM, or an
unwritable trace directory surfaces on the dashboard instead of crashing boot.

## Data and state locations

| State | Where | Notes |
| --- | --- | --- |
| Everything relational | Postgres | See [Data model](data-model.md) |
| Traces (full LLM request/response bodies) | `TRACES_DIR/traces-YYYY-MM.ndjson` | Append-only; the only copy. See [Observability](observability.md) |
| Browser-run screenshots, media bytes | Postgres (`bytea`) | Never in trace JSON |
| Browser-agent downloads | `downloads/` on disk | Delivered to the chat as they land |
| Live job progress, browser live state | RAM (`globalThis`) | Transient by design |
| Running (unsettled) traces | RAM | A crash drops them |

## Key architectural decisions

| Decision | Rationale |
| --- | --- |
| Telegram long polling in-process, not a webhook | Recorded decision; a self-hosted bot behind NAT has no public URL |
| Concurrent update processing via `@grammyjs/runner` with `sequentialize` | Concurrency across chats, strict order within a chat |
| Config in the database, not env | An operator changes the model from the dashboard, not by editing a file and restarting |
| Traces in files, not Postgres | A settled trace is immutable, so a month is a plain append-only log — no rewrite, fold, or compaction. An earlier Postgres mirror was a second, lossy source of truth |
| One SSE connection per tab | Browsers allow ~6 concurrent HTTP/1.1 connections per origin; per-component `EventSource`es would exhaust the budget |
| No separate worker service | One container, in-process singletons, advisory locks for cross-process safety |
| System ffmpeg over a bundled/WASM build | User decision; the image installs it |
| Playwright loaded lazily | It is a `serverExternalPackage`; a static import would put the native package in the boot graph and any resolution problem would crash startup |

Deviating from these requires asking the user first — see the "Decision Notes"
process in `AGENTS.md`.
