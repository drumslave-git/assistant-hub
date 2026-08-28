# assistant-hub — v2 Redesign Plan

The source of truth for the v2 target architecture. Progress and phase
status live in [PROGRESS.md](PROGRESS.md); the pointer entry is in
[TODO.md](TODO.md). This document describes the target as designed — it is
updated in place when the design changes, and carries no decision history
(the session log in PROGRESS.md does).

## Vision

The Telegram bot becomes one connectable source on top of a general
assistant platform named **assistant-hub**. The generic foundation —
pipeline, memory, tools, traces, dashboard — is the product; Telegram, the
dashboard web chat, and any future source (Signal, mobile apps) are
interchangeable source apps that plug into it.

Three pillars:

1. **Every app owns its own data; the dashboard is the one place** — users,
   chats, and messages live in per-app stores, aggregated for the operator
   through a common listing contract.
2. **Assistants** — a first-class entity replacing personalities: many
   assistants sharing one brain (config, memory), each with its own persona
   and its own transport connections.
3. **Pluggable MCP tools** — tool connections managed from the dashboard
   and stored in the DB, instead of a hardcoded in-process toolset.

## Architecture

### Monorepo

Turborepo with npm workspaces. `apps/*` never import each other's code —
only packages. The one sanctioned seam is the dashboard: each source app
ships a `ui` subpackage (a separate workspace package living inside the
app's directory) that only the shell composes at build time; it may import
shared packages only, never its app's server code and never another app.

```
apps/
  core/       Next.js — the hub. Dashboard shell + auth + SSE bridge +
              proxy to the source apps' operator APIs, and the brain:
              reply pipeline, LLM loop, MCP runtime, schedulers,
              background jobs, Playwright. Owns the core store
              (assistants, settings, memory, tasks, tool connections,
              person links, operator sessions, all traces).
  tg/         Telegram source app: one grammY poller per enabled telegram
              connection, its own store (users, chats, messages, media,
              connections), Telegram media ingestion, and an MCP server
              exposing Telegram outbound actions (send_message,
              send_reply, …). Ships its dashboard extensions as
              apps/tg/ui (assistant editor: bot token / connection
              section, status cards, …).
  chat/       Web-chat source app: its own store (users, threads,
              messages, media), inbound events, reply-delivery
              consumption, and an MCP server exposing web-thread outbound
              actions. Ships its dashboard extensions as apps/chat/ui
              (thread list, chat view, …).
packages/
  db/         Shared database tooling: drizzle helpers, migration runner,
              repository conventions. Each app defines its OWN schema and
              migration chain for its own database on top of this.
  contracts/  Zod schemas shared across apps: the source-app contract
              (events, context provider, listing/CRUD API shapes), queue
              payloads, bus events, scoped entity refs, API DTOs.
  ui/         Shared dashboard components + the typed extension-point
              registry the shell composes from.
```

Domain logic with a single consumer (pipeline, prompt composition, tool
loop) lives inside `apps/core`; only genuinely cross-app code becomes a
package (e.g. the trace client the core provides to apps). The exact
package cut is settled in Phase 0.

### Runtime topology

```
Browser ── HTTP/SSE ── apps/core ──┬── LLM endpoint(s)
                          │        ├── remote MCP servers (HTTP)
   proxies /api/<app>/*   │        ├── source-app MCP servers (tg, chat)
   to the source apps ────┤        └── Playwright / media pipelines
                          │
Telegram ─ pollers ─ apps/tg ──┬── Redis (BullMQ queue + pub/sub) ── apps/core
Web-chat backend ── apps/chat ─┘

(source apps: inbound events out, reply-delivery events in,
 each exposes an MCP server for outbound actions)

One Postgres server; each app has its OWN database in it.
```

### Data ownership

Each app is responsible for its own storage — its own logical database,
its own drizzle schema, its own migration chain (on shared tooling from
`packages/db`). No app reads or writes another app's database; all
cross-app access goes through APIs, events, or the bus.

- `apps/core` — the core store: assistants, settings, LLM backend config,
  memory, tasks, tool connections, person links, operator sessions and
  dashboard preferences, and all traces (see Traces and debug). The
  dashboard CRUDs it in-process — no self-proxy.
- `apps/tg` — telegram users, chats, messages (all kinds), media,
  telegram connections (bot token per assistant, desired/actual state).
- `apps/chat` — its own web users, threads, messages, media,
  thread↔assistant binding.

Cross-app references use **scoped refs** (`source:kind:id`, e.g.
`tg:chat:123`, `chat:thread:45`), defined in `packages/contracts`. Memory,
tasks, and traces store scoped refs, never foreign keys into another app's
database.

**Person links:** the core store holds an operator-managed link table
declaring "tg user X = web user Y". Memory reads through it, so what the
bot knows about a person follows them across sources; unlinked users stay
separate. This is the "one place for users" goal realized as linking +
aggregation instead of canonical tables.

**Entity lifecycle across apps:** apps react to core events on the bus
(e.g. `assistant.deleted` → tg disables and removes that assistant's
connection). Source apps create their own entities on first contact — tg
upserts a user/chat the moment someone reaches the bot.

### The source-app contract

`packages/contracts` defines what any source is:

- it owns the storage for its users, chats, messages, and media, and
  creates them on first contact;
- it enqueues normalized inbound events for the core pipeline;
- it **supplies conversation context**: the composed history window and
  participant roster for a chat, carried on the inbound event or served
  on demand — the core never reads a source's store;
- it consumes reply-delivery events for its chats and performs the actual
  send;
- it exposes an MCP server for its outbound actions;
- it exposes an operator API implementing the shared **listing/CRUD
  contract** for its entities (list/search/read/update/delete users,
  chats, messages), which the dashboard aggregates;
- it reconciles its connections from its own desired state and publishes
  actual state.

`apps/tg` and `apps/chat` are the two v2 implementations; adding Signal
later means writing another source app.

Source apps' operator-facing APIs are reached only through the `apps/core`
proxy: the browser talks to one origin, the operator session is
authenticated in one place, and source apps trust only the proxy on the
internal network.

### Message flow

- **Inbound:** the source app persists the message in its own store, then
  enqueues one normalized inbound event (scoped chat/sender refs,
  assistant id, content, reply target, plus the conversation context per
  the contract). The core consumes the queue and runs the same pipeline
  regardless of source.
- **Outbound, deterministic:** the finished reply is published as a
  reply-delivery event; the owning source app consumes it, persists the
  reply in its store, and performs the send (grammY for tg; for web
  threads the update reaches the browser through the SSE bridge). The
  model never has to remember to send its own answer.
- **Outbound, model-driven:** task fires and cross-chat sends are tool
  calls into the source app's MCP server (send_message, send_reply, …),
  which the core registers as a built-in connection.
- **Turn lifecycle:** the core publishes lifecycle events for every
  inbound message — accepted-for-processing, progress (tool activity),
  settled — and the owning source app renders them natively: tg turns
  them into the Telegram typing indicator, web chat into the live thread
  progress. Presence/typing is never an MCP tool.
- **Events:** all apps publish status/progress events on Redis pub/sub;
  `apps/core` bridges them to the SSE layer (the
  `publishEvent`/`useLiveRefresh` contract survives, its backbone
  changes).
- **Control:** dashboard actions write desired state through the owning
  source app's operator API; that app reconciles (e.g. `apps/tg`
  starts/stops pollers) and publishes actual state.

### Dashboard composition (micro-frontends)

The dashboard is a shell in `apps/core` composed from app-owned UI
subpackages via a **build-time extension registry** — one Next.js build,
one origin, Server Components work, no runtime federation. Each source app
ships its dashboard UI as a subpackage inside its own directory
(`apps/tg/ui`, `apps/chat/ui`, …) exporting typed extensions the shell
mounts:

- navigation items and routes/pages (chat contributes the thread list and
  chat view);
- entity-form sections (tg extends the assistant editor with the bot
  token / connection settings, stored in tg's own database through tg's
  API);
- status cards and debug panels;
- aggregated entity views: the shared users/chats/messages pages call
  every source app's listing API through the proxy and merge the results.

Rules: the shell knows extension *points*, never the apps; a UI subpackage
may import only shared packages (never its app's server code, never
another app), and its data access goes through the owning app's operator
API behind the `apps/core` proxy. The extension-point types live in
`packages/ui`. Runtime independence is not a goal — all images release
together on one version, so build-time composition costs nothing
operationally.

### Turn failure handling

No revert machinery. A failed turn **retries only if it performed no
actions yet** — no reply sent, no tool executed, nothing created or changed
beyond storing the inbound message itself. Once any action has run, a
failure does not retry: the turn fails, is reported to the operator (trace
+ dashboard surfacing), and stops. Mechanically this is a per-turn
"actions started" marker in the core store. This guarantees transient
failures before any work never drop messages, and nothing ever
double-sends or double-executes.

## Domain model

### Assistants

Personalities convert into assistants, owned by the core store. Many
assistants, CRUD via dashboard, sharing one brain: LLM backend config,
settings and memory are shared across all assistants. Per-assistant:
persona, transport connections (stored by the owning source app, keyed by
assistant id), standing tasks, and which tool connections it may call.

One bot token per assistant; `apps/tg` runs one poller per enabled
connection; the assistant in a Telegram chat is implied by which bot is in
it.

Behavior in shared chats:

- Assistants do **not** ignore each other's messages; each assistant's
  addressing check is against its own name only.
- **Bot-to-bot loop guard:** a per-chat cap on *consecutive*
  assistant-authored turns — once N assistant↔assistant exchanges happen
  with no human message in between, assistants stay silent in that chat
  until a human speaks. N is operator-configurable (DB-backed setting),
  deterministic, no LLM judgment involved.

### Conversation pipeline

The turn runner generalizes today's `handleIncomingMessage`: addressing
(deterministic own-name check per assistant + analyzer), policy gates,
prompt composition (system + persona + source-supplied chat context +
memory + source-supplied history + current turn), tool loop, honesty gate,
delivery, trace. One BullMQ job per inbound message, with the turn-failure
rules above. Trace events double as progress events on the bus, so web
threads show live typing/tool activity.

### Memory

Core-owned, shared across assistants. Keyed by scoped user/chat refs and
resolved through person links, so knowledge about a linked person is one
body of memory regardless of source.

### Web chat

Served by `apps/chat` (backend + own store) plus its `apps/chat/ui`
extensions in the dashboard (views), with the operator API behind the
`apps/core` proxy.

- The chat app owns its own users. The operator gets a chat user bound to
  the operator session — linkable to their telegram user via person
  links, like any other pair.
- Named threads belong to chat users; each thread is bound to one
  assistant **at creation** (no mid-thread switching).
- v1 scope is everything: text, image upload (vision pipeline), and voice
  (voice pipeline).
- Delivery: message-at-once + live turn progress (typing / tool-call
  events over SSE), not token streaming.

### MCP tool connections

Operator-managed, stored in the core store (config-in-DB direction; no
end-user accounts). A connection's tools reach a turn along three scope
dimensions:

- **global** — offered on every turn (the default for a new connection);
- **per-app** — offered only on turns from one source app, which is how
  each source's own MCP server stays out of the other's prompt;
- **per-assistant** — the operator picks which assistants may call a
  connection (default: all of them).

Per-chat and per-user scoping is not part of v2.

- `tool_connections` (draft): name/slug, transport discriminator (`http`
  live; `stdio` modeled but disabled in v1), endpoint URL, auth headers
  (secrets in DB), enabled, app scope, plus the per-assistant selection.
- Transport v1: Streamable HTTP + legacy SSE with configurable auth
  headers. stdio execution is deferred but designed in via the
  discriminator, so adding it later needs no schema or UI rework.
- Tool discovery at connect time plus an explicit re-sync/apply step: the
  offered toolset is a **snapshot** that changes only on operator command —
  never mid-conversation — preserving llama.cpp prefix-cache stability and
  avoiding strict-provider 400s on schema drift.
- Tool names are prefixed with the connection slug to prevent collisions.
- Built-in feature tools (browse_web, memory, tasks, image-gen, …) remain
  an in-process registry inside the core, alongside remote connections and
  the source apps' MCP servers.

### Traces and debug

Tracing is unified and core-owned: every trace from every app lands in the
core store, and the debug explorer reads exactly one place. Apps never
write trace rows themselves — they record through the trace client the
core provides (a shared package whose implementation delivers trace events
to the core over the bus; the core persists them). A turn's flow still
spans apps (tg inbound → core pipeline → tg outbound); a correlation id
travels with every event and job and ties the whole flow into one trace.
Existing v1 traces are not migrated.

## Migration ("migrate the brain, drop the logs")

Hard requirement: **no brain-data loss**. Downtime at cutover is
acceptable. The v1 database is split into the new per-app databases:

- → `apps/tg` store: known users/groups, message history, media/vision
  descriptions, the bot token (as a telegram connection on the default
  assistant).
- → `apps/core` store: memory, sender preferences, self-improvement
  corrections, tasks (assigned to the default assistant), personalities →
  assistants, settings.
- Out of scope (start fresh): traces, analytics rollups.

Mechanism and safety net:

1. One-shot migration scripts (v1 schema → per-app schemas), written and
   tested during Phase 1 against seeded fixtures.
2. **Mandatory rehearsal** against a copy of the production DB before
   cutover — repeated until clean.
3. Scripted verification: row-count reconciliation per table pair plus
   spot-check queries, run automatically after every rehearsal and at
   cutover.
4. Full DB backup immediately before cutover; the old database is retained
   untouched (read-only) after cutover.
5. Written cutover runbook: stop old → backup → migrate → verify → start
   new → smoke-check (bot answers, dashboard loads, web chat works) →
   rollback path (restore backup, redeploy last v1 image).

## Deployment

Per-app Docker images: `assistant-hub-core`, `assistant-hub-tg`,
`assistant-hub-chat`. The release pipeline builds and publishes all of
them from the same version bump; compose pins every service to the same
tag so containers never run different code versions. Compose runs one
Postgres server hosting one database per app (each app gets its own
connection URL) and one Redis.

## Build phases

Each phase gets detailed acceptance criteria in PROGRESS.md when it starts.

- **Phase 0 — Scaffold.** Turborepo + workspaces; the current app moves
  into `apps/core` (it already is dashboard + pipeline in one process);
  `packages/db` / `contracts` / `ui` carved out with no behavior change;
  the extension-registry skeleton in the shell; CI,
  lint/typecheck/test/build wiring; docker builds the per-app images and
  the release pipeline publishes them all on one version bump.
- **Phase 1 — Schemas + migration.** Per-app databases and schema modules
  (core, tg, chat); scoped-ref and person-link foundations; migration
  scripts splitting the v1 DB + verification harness + rehearsal
  workflow.
- **Phase 2 — Source split.** The Telegram runtime moves out of the core
  into `apps/tg` behind the source contract (inbound events with context,
  reply-delivery events, listing API, tg MCP server); Redis bus + queue;
  the pipeline consumes the queue; dashboard controls go through tg's
  operator API + bus.
- **Phase 3 — Assistants.** CRUD UI, personality conversion, per-assistant
  telegram connections with concurrent pollers (connection settings as a
  `apps/tg/ui` extension of the assistant editor, stored in tg's DB),
  per-assistant tasks, own-name addressing + bot-to-bot rules, aggregated
  users/chats dashboard pages + person links.
- **Phase 4 — Web chat.** `apps/chat` as the second source app plus its
  `apps/chat/ui` extensions: threads UI (create/name/pick assistant), text +
  image upload + voice, live turn progress, message-at-once delivery,
  memory/trace parity with telegram chats.
- **Phase 5 — MCP connections.** HTTP connections CRUD, discovery +
  snapshot/apply, scoping (global / per-app / per-assistant), prefixing,
  the source apps' own MCP servers replacing the core's hand-written
  outbound tool bindings, tools dashboard rework.
- **Phase 6 — Cutover.** Rehearsed migration, runbook execution, rename to
  assistant-hub, release pipeline for the new shape, docs rewrite
  (AGENTS.md describes v1 and must be updated).

Out of scope for v2 (planned, not built): stdio MCP execution, end-user
accounts / self-serve tools, token streaming, Signal, mobile apps.

## Working rules

- Big-bang redesign: the full target is designed here first; intermediate
  states need not be shippable.
- All work happens on one long-lived redesign branch — the sanctioned
  exception to the commit-on-main rule. Main stays releasable for hotfixes;
  the branch is **rebased onto main** after hotfixes (rebases, not merges).
- No version bumps from the branch until cutover.
- Design changes are made by asking the user, then updating this document
  in place; the outcome is logged in PROGRESS.md's session log.
