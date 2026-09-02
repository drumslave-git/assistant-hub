# Architecture overview

Two applications in one Turborepo, one Postgres database, one Redis, one brain.
**`apps/core`** is a Next.js 16 App Router application: the dashboard, the web
chat, the whole reply pipeline, every background job, the MCP tool runtime and
the trace store. **`apps/tg`** is a stateless Telegram transport: it owns the
platform connection and nothing else. They talk over Redis (a BullMQ queue and a
pub/sub channel) and over two small token-authenticated HTTP surfaces. A new
platform connects by deploying another transport container — see
[Adding a transport](../development/adding-a-transport.md).

```
   Telegram ◄──long polling──► apps/tg  (stateless transport, :3210)
                                  │  queue `transport-updates`          ▲ `reply.delivery`, `turn.lifecycle`
                                  ▼  (every message, edit, reaction,    │ (Redis pub/sub `assistant-hub:events`)
                                     delivery — media bytes attached)   │
   dashboard ──HTTP──► apps/core (Next.js, :3200)                       │
   (browser) ◄──SSE──   server/ingest ─► queue `inbound-messages` ─► server/turn ─► features/bot-messaging ──┘
   web chat  ──HTTP──►  features/web-chat ────────────────────────────┘ (same pipeline, in-process)
                                  │
                  ┌───────────────┼───────────────────────┐
                  ▼               ▼                       ▼
           Postgres (store/)   data/traces/         server/llm + server/mcp
           one schema, one     NDJSON, append-only   OpenAI-compatible + native providers;
           migration chain                           in-process tools + remote MCP servers
                                                     (apps/tg's own is one of them)
```

Paths in this document are relative to `apps/core/` unless they start with
`apps/` or `packages/`.

## The two apps and the shared packages

| Workspace | Responsibility | State |
| --- | --- | --- |
| `apps/core` | Dashboard (admin and user roles), web chat, the conversation store, the reply pipeline, background jobs, LLM clients, MCP runtime, traces, realtime | The Postgres database (`store/`), trace files, downloads |
| `apps/tg` | Telegram: pollers per assistant connection, media download, structural addressing, sends, typing, the platform's MCP tools | **None.** It registers with the core at boot and reconciles from the desired state the core answers with |
| `packages/contracts` | Every cross-app zod schema: scoped refs, transport events, reply delivery, turn lifecycle, the internal APIs, the trace contract, realtime topics | — |
| `packages/bus` | BullMQ queues (`attempts: 1`) and the ioredis pub/sub bus | — |
| `packages/service` | What every transport service needs once: env access, the internal-token guard, serving an MCP server over Hono, the bus trace client and dashboard-refresh ping | — |
| `packages/media` | Image normalization to a bounded JPEG (shared by core and transports) | — |
| `packages/db` | Pool helpers, the production migration runner, Testcontainers helpers | — |
| `packages/ui` | Shared presentational components and the live-event hook | — |

Apps never import each other's code — only packages. Cross-app pointers are
scoped refs (`tg:user:123`, `chat:thread:<id>`), never foreign keys into another
app's data.

## Layers inside the core

| Directory | Responsibility | Rules |
| --- | --- | --- |
| `app/` | App Router routes, layouts, Route Handlers (`app/api/**/route.ts`). `app/(dashboard)/(admin)/` holds the admin-only pages | Handlers stay thin: declare schemas, declare an access level, delegate to a service |
| `components/` | Shared presentational dashboard UI | No feature business logic. `components/ui/` is the design kit, `components/layout/` the app shell, `components/debug/` the shared Debug views, `components/transports/` the schema-driven transport sections |
| `features/` | One directory per product feature: pure logic at the root, `server/` for services, `ui/` for its components | Follows the feature contract (see [Contributing](../development/contributing.md)) |
| `server/` | Server-only domain infrastructure: auth, HTTP wrappers, ownership, LLM clients, MCP, jobs, trace, realtime, the bus, the ingest and turn consumers, the conversation store repositories (`server/source-store/`), transport registrations (`server/transports/`) | Modules touching secrets, the database, the filesystem or the LLM import `server-only` |
| `store/` | THE database module: the Drizzle schema (`schema.ts`) and the one migration chain (`migrations/`). The pooled handle is `server/store/db.ts` (`getStoreDb()`) | Edit the schema, `npm run db:generate`, commit the SQL, `npm run db:migrate` |
| `lib/` | Small shared contracts importable from **both** client and server | Pure. No `server-only`, no database, no secrets |
| `test/` | Stubs, fixtures, the Testcontainers database helper (`test/store-db.ts`) | — |

Path alias: `@/*` maps to `apps/core/`. Workspace packages are imported by name
(`@assistant-hub-swarm/*`).

### The import boundary

The boundary is enforced by the `server-only` package rather than by convention.
`server/env.ts`, `server/http.ts`, every repository and every service import it,
so pulling one into a client bundle is a build error.

Pure contracts the dashboard must render — `lib/api-error.ts`, `lib/trace.ts`,
`lib/realtime.ts`, `lib/features.ts`, `lib/format.ts`, `lib/language.ts`,
`lib/embeddings.ts`, `lib/message-refs.ts`, `lib/llm-backend.ts` — are
intentionally **not** server-only. Feature `types.ts` and pure `format.ts`
modules follow the same rule: a Client Component can import them, so a
`server-only` import there would break the dashboard.

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
    repository.ts     typed persistence — pure data access, takes a StoreDb
    service.ts        the boundary: policy, validation, tracing
    scheduler.ts      background wiring, when the feature has a job
    mcp-tools.ts      the feature's MCP tools, when it exposes any
    *.integration.test.ts
  ui/
    *.tsx             the feature's dashboard components
```

The separation is strict on purpose: repositories hold no policy and no tracing,
services hold no SQL, and route handlers hold neither. A repository takes a
`StoreDb` argument so the same code runs against the production pool and
against a Testcontainers instance.

## Request lifecycle (dashboard API)

1. `proxy.ts` (Next 16's renamed middleware convention) does an **optimistic**
   redirect: no session cookie present → `/login`. It cannot verify the cookie,
   because verification needs the account's DB-stored secret. API routes are
   excluded (they answer 401 JSON, not a redirect).
2. `defineRoute` (`server/http.ts`) wraps the handler with an **access level**:
   `admin` (the default — a signed-in admin), `account` (any signed-in active
   account) or `public` (the auth endpoints and the health probe, nowhere
   else). It resolves the account, refuses a user-role account on an admin
   route, holds an account with a temporary password at the password change,
   awaits the dynamic route params, runs the body, and maps any thrown value
   to the shared error envelope.
3. The body parses input with a zod schema (`parseJson`, `parseQuery`,
   `readJsonBody`) and calls a service. Account-level routes scope their data
   through the ownership helpers in `server/ownership.ts`: a user-role account
   reaches its own assistants and what they do, and an id outside that scope
   answers not-found rather than forbidden, so nothing leaks.
4. The service validates policy, does its work through a repository, records a
   trace, publishes a realtime event, and returns a client-safe shape.
5. `ok(data)` wraps the result as `{ data }`; `jsonDownload` / `csvDownload`
   produce attachments instead.

One family bypasses sessions entirely: `app/api/internal/transports/**` are
plain handlers authenticated by the `x-internal-token` header, equal to
`INTERNAL_API_TOKEN`. They are for transport services, never the browser. Auth
is enforced at *both* the proxy and `defineRoute`, so the API stays covered even
when the proxy is bypassed.

## Request lifecycle (dashboard pages)

Pages are Server Components that call services directly — no internal fetch. The
real page-side auth gate is `app/(dashboard)/layout.tsx`, which verifies the
cookie signature against the account's DB-stored secret before rendering
anything: a fresh install with no account goes to `/setup`, a bare visitor to
`/login`, an account still holding its temporary password to `/password`. The
shell's navigation is role-aware (`components/layout/nav-config.ts`): a
user-role account sees History, Assistants, Tools, Tasks, Debug, Chat and
Profile, scoped to its own world. `app/layout.tsx` is a bare document shell so
`/login` and `/setup` render without app chrome.

Interactivity is pushed to leaf Client Components. Data stays server-rendered and
is kept fresh over SSE — see [Observability](observability.md#live-updates).

## Message lifecycle (the cross-app hot path)

The full walk-through is [The message pipeline](telegram-pipeline.md). In short:

1. **The transport forwards.** `apps/tg` receives an update, downloads any
   media, computes the structural addressing verdict for each running bot, and
   publishes one `transport.message` job on the `transport-updates` queue.
   Everything is forwarded, addressed or not.
2. **The ingest persists and fans out** (`server/ingest/consumer.ts`): the
   sender and the message land in the conversation store (`source_*` tables),
   media is stored as pending rows, self-link codes and feedback replies are
   consumed here, and for every assistant present in the chat a
   `message.inbound` turn event is built — history window, participants, chat
   and sender info composed from the store — and enqueued on
   `inbound-messages`.
3. **The turn consumer runs the pipeline** (`server/turn/consume.ts` →
   `features/bot-messaging/server/service.ts`): per-chat sequential, cross-chat
   concurrent; the name check and the LLM analyzer settle the ambiguous group
   cases; the tool loop runs; the reply is published as one `reply.delivery`
   event and the turn's `accepted` / `progress` / `settled` lifecycle as
   `turn.lifecycle` events on the bus.
4. **The transport delivers**: it renders the reply for its platform, sends it,
   shows typing from the lifecycle events, and reports `message.delivered`.
5. **The ingest mirrors the delivery** as an assistant row and, in a group,
   cross-feeds it to the other assistants present as their own turns.

The web chat runs the same pipeline in-process: `features/web-chat` stores the
message, builds the same turn event, and consumes its own `reply.delivery` /
`turn.lifecycle` events from the bus (`server/source/events-consumer.ts`).

## Process singletons

Several things must exist exactly once per process and must survive Next's bundle
re-evaluation and dev hot-reload. Each is held on a `globalThis` slot keyed by a
`Symbol.for("assistant-hub.…")`, because a module-local would be re-created per
bundle copy:

| Singleton | Module | Why it must be single |
| --- | --- | --- |
| Postgres pool + Drizzle handle | `server/store/db.ts` | A module-local leaks connections on every hot reload |
| Inbound queue producer | `server/turn/enqueue.ts` | One BullMQ producer for the pipeline's entrance |
| Bus publisher | `server/bus/publisher.ts` | One pub/sub connection for service-level events (`assistant.deleted`, `transport.config.changed`) |
| MCP registry + tool context | `server/mcp/runtime.ts`, `server/mcp/context.ts` | Tools are registered once; the per-turn `AsyncLocalStorage` binding is one store |
| Realtime hub | `server/realtime/hub.ts` | One pub/sub bus shared by publishers and the SSE route |
| Trace store | `server/trace/store.ts` | Writers and the boot-owned flush timer must share one instance |
| LLM priority gate | `server/llm/priority.ts` | Replies outrank background calls; the gate must see every call |
| Status cache | `server/status.ts` | The Overview probes are cached once per process |
| Shared Chromium | `features/link-fetch/server/playwright.ts` | Launching costs about a second; a per-module copy leaks browser processes |
| Adblock engine | `features/link-fetch/server/adblock.ts` | One prebuilt filter engine per process |
| Each scheduler | `server/jobs/daily-scheduler.ts` (per job name), the idle and interval schedulers per feature | Exactly one ticker per job |
| Browser-run live state, ack registry, run signal | `features/browser-agent/server/{live-state,ack,signal}.ts` | Ephemeral per-run progress, deliberately not persisted |
| Web-chat running turns | `features/web-chat/server/turns.ts` | The thread view's "thinking…" state, fed by lifecycle events |
| Insight scan floor | `features/analytics/server/watermark.ts` | Process-local lower bound for the due-scan |

The consequence: the core is a **single-instance** design. Scaling to multiple
replicas would need an external fan-out behind the realtime hub's API and an
external trace store behind the store's API. Cross-process *job* overlap is
already handled — see [Background jobs](background-jobs.md#advisory-locks).
The transport is single-instance per bot token by nature: Telegram permits
exactly one `getUpdates` consumer per token.

## Boot sequence

`instrumentation.ts` → `register()` runs once per server instance. It returns
immediately unless `NEXT_RUNTIME === "nodejs"`, then dynamically imports
`server/boot/register-node.ts` — the split keeps Node-only `process` APIs out
of the Edge-analyzed instrumentation module.

`registerNode()` then, in order:

1. Registers `SIGTERM`/`SIGINT` handlers that close the queue consumers and the
   bus subscription, stop every scheduler, flush the trace store, and exit.
2. Arms the trace store: warms the current month from disk and starts the
   periodic flush.
3. Starts the **inbound turn consumer** (`inbound-messages`) — the pipeline's
   only entrance — and the **transport ingest** (`transport-updates`). Both
   need `REDIS_URL` and `DATABASE_URL`; without them the core boots but
   processes no messages, and says so loudly in the log.
4. Starts the **source events consumer** on the bus: the SSE bridge for
   `dashboard.refresh`, `trace.recorded` from the transports, `feedback.recorded`,
   and the web chat's own deliveries and lifecycle.
5. Reconciles the **managed tool connections**: every registered transport's
   MCP server is discovered and its toolset applied, so the tools that ship
   with a release are offered without an operator pressing Apply.
6. Starts the eight schedulers — vision backfill and history indexing (idle),
   tasks (interval), self-improvement, history summaries, memory, analytics
   insights and the yt-dlp updater (daily) — and the browser-agent runner,
   which first sweeps any run left `running` by a previous process to `failed`.

Nothing here gates readiness. A missing Redis, an unreachable LLM, a transport
that has not registered yet, or an unwritable trace directory surfaces on the
dashboard instead of crashing boot.

The transport's boot is its own: `apps/tg/src/index.ts` serves `/health` first,
registers with the core (retrying until it answers), reconciles its pollers
from the desired state, subscribes to config changes, and starts its delivery
consumer.

## Data and state locations

| State | Where | Notes |
| --- | --- | --- |
| Everything relational | Postgres | See [Data model](data-model.md) |
| Traces (full LLM request/response bodies) | `data/traces/traces-YYYY-MM.ndjson` | Append-only; the only copy. See [Observability](observability.md) |
| Queued transport updates and turns | Redis (`transport-updates`, `inbound-messages`) | AOF-persisted under `./data/redis`; a queued message survives a restart. Completed jobs are retained for a while (see [Security](security.md#data-sensitivity)) |
| Browser-run screenshots, media bytes | Postgres (`bytea`) | Never in trace JSON |
| Browser-agent downloads | `data/downloads/` on disk | Delivered to the chat as they land |
| Live job progress, browser live state, running web-chat turns | RAM (`globalThis`) | Transient by design |
| Running (unsettled) traces | RAM | A crash drops them |
| The transport's poller state | RAM in `apps/tg` | Reported on `/health`; rebuilt from the desired state at boot |

## Key architectural decisions

| Decision | Rationale |
| --- | --- |
| Stateless transports, one store in the core (Phase 7, 2026-08-30) | A transport is a translation layer; storing conversations in two places was two sources of truth. The core owns the mirror, presence, context composition and the cross-feed |
| A transport connects with no core change | Registration announces its config schemas; the dashboard renders them; platform actions are the transport's own MCP tools. The source id is whatever registers (validated by shape, checked against the registration table at runtime — no list in the core); the one handshake is the contract major. Dashboard surfaces still keyed on Telegram are tracked in `docs/TODO.md` and listed in [Adding a transport](../development/adding-a-transport.md#known-telegram-only-surfaces) |
| Redis queue with `attempts: 1` (user decision, 2026-08-22) | The queue never retries on its own. A failed turn is re-enqueued only when it performed no action yet — the turn runner alone can know that |
| Telegram long polling in the transport, not a webhook | A self-hosted bot behind NAT has no public URL |
| Per-chat sequential, cross-chat concurrent (user decision, 2026-07-20) | Kept at every stage: the poller's `sequentialize`, the ingest's per-chat chains, the turn consumer's per-chat chains |
| Config in the database, not env | An operator changes the model from the dashboard, not by editing a file and restarting. Env is bootstrap only |
| DB-backed accounts with roles (Phase 8) | The single operator password and the single global owner are retired; owner rights resolve through the assistant's owning account and identity links |
| Traces in files, not Postgres | A settled trace is immutable, so a month is a plain append-only log — no rewrite, fold, or compaction |
| One SSE connection per tab | Browsers allow about six concurrent HTTP/1.1 connections per origin; per-component `EventSource`s would exhaust the budget |
| Background jobs in-process, no worker service | One core container, in-process singletons, advisory locks for cross-process safety |
| System ffmpeg over a bundled/WASM build | User decision; both images install it |
| yt-dlp for media-page downloads, kept current by the app itself (user decisions, 2026-07-29 and 2026-08-01) | A media site's player exposes no file URL; a stale build fails every media page, so the image pins a floor and a daily job installs newer ones into `data/bin` |
| Playwright loaded lazily | It is a `serverExternalPackage`; a static import would put the native package in the boot graph |

Deviating from these requires asking the user first — see the "Decision Notes"
process in `AGENTS.md`.
