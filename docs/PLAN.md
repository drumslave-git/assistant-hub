# assistant-hub — v2 Redesign Plan

The source of truth for the v2 target architecture. Progress and phase
status live in [PROGRESS.md](PROGRESS.md); the pointer entry is in
[TODO.md](TODO.md). This document describes the target as designed — it is
updated in place when the design changes, and carries no decision history
(the session log in PROGRESS.md does).

## Vision

The Telegram bot becomes one connectable source on top of a general
assistant platform named **assistant-hub**. The generic foundation —
pipeline, memory, history, tools, traces, dashboard — is the product;
Telegram, the dashboard web chat, and any future source (Signal, mobile
apps) are interchangeable source apps that plug into it.

Three pillars:

1. **One place for users, groups, chats** — canonical entities with
   per-source identity bindings.
2. **Assistants** — a first-class entity replacing personalities: many
   assistants sharing one brain (config, memory, history), each with its
   own persona and its own transport connections.
3. **Pluggable MCP tools** — tool connections managed from the dashboard
   and stored in the DB, instead of a hardcoded in-process toolset.

## Architecture

### Monorepo

Turborepo with npm workspaces. `apps/*` never import each other — only
packages. The backend (API layer) and the dashboard stay together as one
Next.js app; they are never split.

```
apps/
  web/        Next.js — dashboard shell + API + auth + SSE bridge + proxy
              to the source apps' operator APIs. Hosts the composed
              dashboard (see Dashboard composition). Not a source app.
  worker/     Reply pipeline, LLM loop, MCP runtime, schedulers, background
              jobs, Playwright. No source code.
  tg/         Telegram source app: one grammY poller per enabled telegram
              connection, inbound events, Telegram media ingestion, and an
              MCP server exposing Telegram outbound actions (send_message,
              send_reply, typing, …).
  chat/       Web-chat source app: thread/message persistence, inbound
              events, reply-delivery consumption, and an MCP server
              exposing web-thread outbound actions. Its operator API is
              reached through the apps/web proxy.
packages/
  db/         Drizzle schema, migrations, repositories.
  core/       Domain logic: pipeline, assistants, identity, prompt
              composition, tool loop, trace recording. Framework-free,
              server-only.
  contracts/  Zod schemas shared across apps: the source-app contract,
              queue payloads, bus events, API DTOs.
  ui/         Shared dashboard components + the typed extension-point
              registry the shell composes from.
  tg-ui/      tg's dashboard extensions (assistant editor: bot token /
              connection section, status cards, …).
  chat-ui/    chat's dashboard extensions (thread list, chat view, …).
```

The exact package cut (e.g. whether `contracts` folds into `core`, and
whether an app's UI package lives under `packages/` or inside the app's
workspace) is settled in Phase 0.

### Runtime topology

```
Browser ── HTTP/SSE ── apps/web (shell + API + SSE bridge)
                          │ proxies /api/chat/* and /api/tg/*
                          │ to the owning source app
                          │
Telegram ─ pollers ─ apps/tg ──┐
Web-chat backend ── apps/chat ─┼── Redis (BullMQ queue + pub/sub) ── apps/worker
apps/web (bus bridge) ─────────┘                                       │
                                            LLM endpoint(s) ───────────┤
        (source apps: inbound              remote MCP servers (HTTP) ──┤
         events out, reply-delivery        source-app MCP servers ─────┤
         events in, each exposes an        Playwright / media ─────────┘
         MCP server for outbound
         actions)

Postgres is shared by all apps.
```

### The source-app contract

`packages/contracts` defines what any source is:

- it persists incoming messages and enqueues normalized inbound events;
- it consumes reply-delivery events for its chats and performs the actual
  send;
- it exposes an MCP server for its outbound actions;
- it reconciles its connections from DB desired state and publishes actual
  state.

`apps/tg` and `apps/chat` are the two v2 implementations; adding Signal
later means writing another source app.

Source apps' operator-facing APIs are reached only through the `apps/web`
proxy: the browser talks to one origin, the operator session is
authenticated in one place, and source apps trust only the proxy on the
internal network.

### Message flow

- **Inbound:** every source app persists the message and enqueues one
  normalized inbound event (canonical chat id, canonical sender id,
  assistant id, content — text / media refs / voice — reply target). The
  worker consumes the queue and runs the same pipeline regardless of
  source.
- **Outbound, deterministic:** the finished reply is published as a
  reply-delivery event; the owning source app consumes it and performs the
  send (grammY for tg; for web threads `apps/chat` persists the reply and
  the update reaches the browser through the SSE bridge). The model never
  has to remember to send its own answer.
- **Outbound, model-driven:** task fires and cross-chat sends are tool
  calls into the source app's MCP server (send_message, send_reply, …),
  which the worker registers as a built-in connection.
- **Events:** worker and source apps publish status/progress events on
  Redis pub/sub; `apps/web` bridges them to the SSE layer (the
  `publishEvent`/`useLiveRefresh` contract survives, its backbone changes).
- **Control:** dashboard actions (enable/disable a connection, start/stop)
  write desired state to the DB and nudge the owning app over the bus; that
  app reconciles (e.g. `apps/tg` starts/stops pollers) and publishes actual
  state.

### Dashboard composition (micro-frontends)

The dashboard is a shell in `apps/web` composed from app-owned UI packages
via a **build-time extension registry** — one Next.js build, one origin,
Server Components work, no runtime federation. Each app owns a dashboard UI
package (`packages/tg-ui`, `packages/chat-ui`, …) exporting typed
extensions the shell mounts:

- navigation items and routes/pages (chat contributes the thread list and
  chat view);
- entity-form sections (tg extends the assistant editor with the bot
  token / connection settings);
- status cards and debug panels.

Rules: the shell knows extension *points*, never the apps; a UI package may
import only shared packages (never another app), and its data access goes
through the owning app's operator API behind the `apps/web` proxy. The
extension-point types live in `packages/ui`. Runtime independence is not a
goal — all images release together on one version, so build-time
composition costs nothing operationally.

### Turn failure handling

No revert machinery. A failed turn **retries only if it performed no
actions yet** — no reply sent, no tool executed, nothing created or changed
beyond storing the inbound message itself. Once any action has run, a
failure does not retry: the turn fails, is reported to the operator (trace
+ dashboard surfacing), and stops. Mechanically this is a per-turn
"actions started" marker. This guarantees transient failures before any
work never drop messages, and nothing ever double-sends or double-executes.

## Domain model

### Identity

Canonical, source-agnostic entities; per-source bindings. Draft schema,
refined in Phase 1:

- `users` — canonical person: id, display name, operator flag, notes.
- `user_identities` — `(user_id, source, external_id)` unique per
  `(source, external_id)`, plus per-source profile fields.
- `chats` — canonical conversation: id, kind (`dm` / `group` / `thread`),
  title.
- `chat_identities` — `(chat_id, source, external_id)`.

Every feature (history, memory, analytics, tasks) keys on canonical ids.
Today's `known-users` / `known-groups` data becomes canonical rows with
telegram bindings.

### Assistants

Personalities convert into assistants. Many assistants, CRUD via dashboard,
sharing one brain: LLM backend config, settings, memory, history, and (for
v1) MCP tool connections are shared across all assistants. Per-assistant:
persona, transport connections, standing tasks.

- `assistants` — id, name, persona prompt, timestamps (draft).
- `assistant_connections` — assistant id, source (`telegram` for now),
  credentials (bot token), enabled/desired state, runtime status. One bot
  token per assistant; `apps/tg` runs one poller per enabled connection;
  the assistant in a Telegram chat is implied by which bot is in it.

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
prompt composition (system + persona + chat context + memory + history +
current turn), tool loop, honesty gate, delivery, trace. One BullMQ job per
inbound message, with the turn-failure rules above. Trace events double as
progress events on the bus, so web threads show live typing/tool activity.

### Web chat

Served by `apps/chat` (backend, source contract) plus `chat-ui` extensions
in the dashboard (views), with the operator API behind the `apps/web`
proxy.

- Operator + named threads: the operator session maps to a canonical user
  with a `web` identity binding; threads are `chats` of kind `thread`,
  owned by the operator, each bound to one assistant **at creation** (no
  mid-thread switching).
- v1 scope is everything: text, image upload (vision pipeline), and voice
  (voice pipeline).
- Delivery: message-at-once + live turn progress (typing / tool-call events
  over SSE), not token streaming.

### MCP tool connections

Operator-managed, DB-backed (config-in-DB direction; no end-user accounts),
scopable global / per-chat / per-user. Shared across assistants in v1;
per-assistant toolset selection is planned later — the schema leaves room.

- `tool_connections` (draft): name/slug, transport discriminator (`http`
  live; `stdio` modeled but disabled in v1), endpoint URL, auth headers
  (secrets in DB), enabled, scope.
- Transport v1: Streamable HTTP + legacy SSE with configurable auth
  headers. stdio execution is deferred but designed in via the
  discriminator, so adding it later needs no schema or UI rework.
- Tool discovery at connect time plus an explicit re-sync/apply step: the
  offered toolset is a **snapshot** that changes only on operator command —
  never mid-conversation — preserving llama.cpp prefix-cache stability and
  avoiding strict-provider 400s on schema drift.
- Tool names are prefixed with the connection slug to prevent collisions.
- Built-in feature tools (browse_web, memory, tasks, image-gen, …) remain
  an in-process registry inside the worker, alongside remote connections
  and the source apps' MCP servers.

### Traces and debug

DB-backed trace store as today; all apps record, the dashboard debug
explorer reads. Existing traces are not migrated.

## Migration ("migrate the brain, drop the logs")

Hard requirement: **no brain-data loss**. Downtime at cutover is
acceptable.

In scope (migrated): canonical users/chats from known-users/known-groups
(+ telegram bindings), history messages, memory, sender preferences,
self-improvement corrections, tasks (assigned to the default assistant),
personalities → assistants, settings, media/vision descriptions. The
current bot token becomes a telegram connection on the assistant converted
from the active personality.

Out of scope (start fresh): traces, analytics rollups.

Mechanism and safety net:

1. One-shot migration scripts (old schema → new schema), written and tested
   during Phase 1 against seeded fixtures.
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

Per-app Docker images: `assistant-hub-web`, `assistant-hub-worker`,
`assistant-hub-tg`, `assistant-hub-chat`. The release pipeline builds and
publishes all of them from the same version bump; compose pins every
service to the same tag so containers never run different code versions.
Redis joins docker-compose.

## Build phases

Each phase gets detailed acceptance criteria in PROGRESS.md when it starts.

- **Phase 0 — Scaffold.** Turborepo + workspaces; current app moves into
  `apps/web`; `packages/db` / `core` / `contracts` / `ui` carved out with
  no behavior change; the extension-registry skeleton in the shell; CI,
  lint/typecheck/test/build wiring; docker builds the per-app images and
  the release pipeline publishes them all on one version bump.
- **Phase 1 — Schema + migration.** Canonical identity, assistants,
  connections, tool-connection tables in `packages/db`; migration scripts +
  verification harness + rehearsal workflow.
- **Phase 2 — Runtime split.** Pipeline, schedulers, jobs, MCP runtime move
  to `apps/worker`; the Telegram runtime moves to `apps/tg` behind the
  source contract (inbound events, reply-delivery events, tg MCP server);
  Redis bus + queue; SSE bridged in `apps/web`; dashboard controls go
  through desired-state + bus.
- **Phase 3 — Assistants.** CRUD UI, personality conversion, per-assistant
  telegram connections with concurrent pollers (connection settings as a
  `tg-ui` extension of the assistant editor), per-assistant tasks, own-name
  addressing + bot-to-bot rules.
- **Phase 4 — Web chat.** `apps/chat` as the second source app plus its
  `chat-ui` extensions: threads UI (create/name/pick assistant), text +
  image upload + voice, live turn progress, message-at-once delivery,
  history/memory/trace parity with telegram chats.
- **Phase 5 — MCP connections.** HTTP connections CRUD, discovery +
  snapshot/apply, scoping, prefixing, tools dashboard rework.
- **Phase 6 — Cutover.** Rehearsed migration, runbook execution, rename to
  assistant-hub, release pipeline for the new shape, docs rewrite
  (AGENTS.md describes v1 and must be updated).

Out of scope for v2 (planned, not built): stdio MCP execution,
per-assistant toolset selection, end-user accounts / self-serve tools,
token streaming, Signal, mobile apps.

## Working rules

- Big-bang redesign: the full target is designed here first; intermediate
  states need not be shippable.
- All work happens on one long-lived redesign branch — the sanctioned
  exception to the commit-on-main rule. Main stays releasable for hotfixes;
  the branch is **rebased onto main** after hotfixes (rebases, not merges).
- No version bumps from the branch until cutover.
- Design changes are made by asking the user, then updating this document
  in place; the outcome is logged in PROGRESS.md's session log.
