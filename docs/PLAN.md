# v2 Redesign Plan

Status: **planning** — decisions agreed, architecture drafted, no code yet.
Progress is tracked in [PROGRESS.md](PROGRESS.md); the pointer entry lives in
[TODO.md](TODO.md). Decisions for this effort are recorded here (user decision,
2026-08-21), not in TODO.md.

## Vision

The Telegram bot becomes one connectable source on top of a general assistant
platform. The generic foundation (pipeline, memory, history, tools, traces,
dashboard) is the product; Telegram, the dashboard web chat, and any future
source (Signal, mobile apps) are transports that plug into it.

Three pillars:

1. **One place for users, groups, chats** — canonical entities with per-source
   identity bindings.
2. **Assistants** — a first-class entity replacing personalities: many
   assistants sharing one brain (config, memory, history), each with its own
   persona and its own transport connections.
3. **Pluggable MCP tools** — tool connections managed from the dashboard and
   stored in the DB, instead of a hardcoded in-process toolset.

## Decision log (user, 2026-08-21)

Structure:

- **Monorepo with Turborepo.** `apps/*` + `packages/*`. The backend (API
  layer) and the dashboard stay together as one Next.js app — do NOT split
  them into separate apps.
- **Two runtime apps.** `apps/web` (Next.js dashboard + API) and `apps/worker`
  (Telegram pollers, schedulers, background jobs, reply pipeline).
- **Worker owns the whole reply pipeline** (LLM loop, MCP runtime) for every
  source. The web app persists + enqueues inbound web messages; the worker
  runs the turn; replies come back over the event bus.
- **Redis pub/sub + queue** (BullMQ) is the inter-process transport. Redis
  joins docker-compose.

Domain model:

- **Canonical identity + bindings.** Source-agnostic `users`/`chats` with
  internal ids; identity-binding tables map `(source, external_id)` to the
  canonical entity. Every feature keys on canonical ids.
- **No "channels" concept — Assistant entity.** Personalities convert into
  assistants. Many assistants, CRUD via dashboard. Configs, memories, and
  history are SHARED across assistants (one brain, many faces).
- **One Telegram bot token per assistant.** A telegram connection belongs to
  an assistant and runs its own poller in the worker; the assistant in a
  Telegram chat is implied by which bot is in it.
- **Assistants do not ignore each other's messages** in a shared chat; each
  assistant's addressing check is against its own name only. (Replaces the
  blanket `from_bot` ignore between assistant bots; see the loop-guard open
  item.)
- **Tasks are per assistant** (assistant + chat), not global per chat.
- **MCP tool connections are shared across assistants for v1**; per-assistant
  toolset selection is planned for later — the schema must leave room for it.

Web chat:

- **Operator user + named threads.** The operator session maps to a canonical
  user with a `web` identity binding; multiple named threads, each a
  first-class chat. The thread's assistant is **fixed at thread creation** —
  no mid-thread switching.
- **v1 scope is everything:** text, image upload (vision pipeline), and voice
  (voice pipeline) from day one.
- **Delivery: message-at-once + live turn progress** (typing / tool-call
  events over SSE), not token streaming.

MCP connections:

- **Operator-managed, DB-backed** (config-in-DB direction; no end-user
  accounts yet), scopable global / per-chat / per-user.
- **HTTP transport only in v1** (Streamable HTTP + legacy SSE, configurable
  auth headers). **stdio is out of scope for v1 but designed in**: the
  connection entity carries a transport discriminator so stdio can be added
  without schema or UI rework. (Revises the earlier "HTTP + stdio" pick,
  user, 2026-08-21.)

Execution:

- **Big-bang redesign** — full target designed first, then rebuilt toward it;
  intermediate states need not be shippable.
- **Long-lived redesign branch** — the sanctioned exception to the
  no-branches rule. Main stays releasable for hotfixes; no version bumps from
  the branch until cutover. The branch is **rebased onto main** after
  hotfixes (rebases, not merges).
- **Data: migrate the brain, drop the logs.** No data loss on brain data is
  the hard requirement; downtime at cutover does not matter. Traces and
  analytics start fresh.
- **The repo/product gets renamed** (`llm-tg-bot-nextjs` no longer fits).
  New name: TBD (open item).

## Target architecture

### Monorepo layout (proposed)

```
apps/
  web/        Next.js — dashboard + API + auth + SSE. Owns all HTTP.
  worker/     Bot runtimes (one grammY poller per enabled telegram
              connection), schedulers, background jobs, the reply pipeline,
              the MCP runtime, Playwright.
packages/
  db/         Drizzle schema, migrations, repositories.
  core/       Domain logic: pipeline, assistants, identity, prompt
              composition, tool loop, trace recording. Framework-free,
              server-only.
  contracts/  Zod schemas shared web <-> worker: queue payloads, bus events,
              API DTOs.
```

Exact package cut (e.g. whether `contracts` folds into `core`) is settled in
Phase 0; the rule is: `apps/*` never import each other — only packages.

### Runtime topology

```
Browser ── HTTP/SSE ── apps/web ──────────── Postgres
                          │                     │
                          ├── Redis (BullMQ queue + pub/sub)
                          │                     │
                       apps/worker ─────────────┘
                          │
                          ├── Telegram (grammY pollers, 1 per connection)
                          ├── LLM endpoint(s)
                          ├── Remote MCP servers (HTTP)
                          └── Playwright / media pipelines
```

- Inbound: telegram updates arrive in the worker directly; web messages are
  persisted by `apps/web` and enqueued. Both normalize into one canonical
  inbound-message shape and enter the same pipeline.
- Outbound: the pipeline delivers through a per-source outbound transport
  (evolution of today's `ReplyTransport`) — grammY for telegram, bus events
  for web threads.
- Events: worker publishes status/progress/reply events on Redis pub/sub;
  `apps/web` bridges them to the existing SSE layer (the
  `publishEvent`/`useLiveRefresh` contract survives, its backbone changes).
- Control: dashboard actions (enable/disable a connection, start/stop) write
  desired state to the DB and nudge the worker over the bus; the worker
  reconciles and publishes actual state.

### Identity model (draft — refined in Phase 1)

- `users` — canonical person: id, display name, operator flag, notes.
- `user_identities` — `(user_id, source, external_id)` unique per
  `(source, external_id)`, plus per-source profile fields (username, etc.).
- `chats` — canonical conversation: id, kind (`dm` / `group` / `thread`),
  title.
- `chat_identities` — `(chat_id, source, external_id)`.
- Web threads are `chats` of kind `thread`: owned by the operator's canonical
  user, bound to one assistant at creation.

Today's `known-users` / `known-groups` data becomes canonical rows with
telegram bindings.

### Assistants

- `assistants` — id, name, persona prompt, timestamps (draft; converted from
  `personalities`).
- Shared across assistants: LLM backend config, settings, memory, history,
  MCP tool connections (v1).
- Per-assistant: persona, transport connections, standing tasks.
- `assistant_connections` — assistant id, source (`telegram` for now),
  credentials (bot token), enabled/desired state, runtime status. One worker
  poller per enabled telegram connection.
- Migration default: the current bot token becomes a telegram connection on
  the assistant converted from the currently active personality.

### Conversation pipeline

- Source adapters normalize into a canonical inbound message: canonical chat
  id, canonical sender id, assistant id, content (text / media refs / voice),
  reply target.
- One BullMQ job per inbound message. Retry semantics must not double-send:
  retries are safe only before side effects; the turn runner dedupes by
  message id (design detail, Phase 2).
- The turn runner generalizes today's `handleIncomingMessage`: addressing
  (deterministic own-name check per assistant + analyzer), policy gates,
  prompt composition (system + persona + chat context + memory + history +
  current turn), tool loop, honesty gate, delivery, trace.
- Turn progress: trace events double as progress events published on the bus
  so the web thread shows live typing/tool activity.

### MCP tool connections

- `tool_connections` (draft): name/slug, transport discriminator (`http` live;
  `stdio` modeled, disabled in v1), endpoint URL, auth headers (secrets in
  DB), enabled, scope (`global` / chat / user).
- Tool discovery at connect time plus an explicit re-sync/apply step: the
  offered toolset is a **snapshot** that changes only on operator command —
  never mid-conversation — preserving llama.cpp prefix-cache stability and
  avoiding strict-provider 400s on schema drift.
- Tool names are prefixed with the connection slug to prevent collisions.
- Built-in feature tools (browse_web, memory, tasks, image-gen, …) remain an
  in-process registry inside the worker, alongside remote connections.

### Traces and debug

DB-backed trace store as today; both apps record, the dashboard debug
explorer reads. Existing traces are not migrated (logs are dropped).

## Migration ("migrate the brain, drop the logs")

Hard requirement: **no brain-data loss**. Downtime at cutover is acceptable.

In scope (migrated): canonical users/chats from known-users/known-groups (+
telegram bindings), history messages, memory, sender preferences,
self-improvement corrections, tasks (assigned to the default assistant),
personalities → assistants, settings, media/vision descriptions.

Out of scope (start fresh): traces, analytics rollups.

Mechanism and safety net:

1. One-shot migration scripts (old schema → new schema), written and tested
   during Phase 1 against seeded fixtures.
2. **Mandatory rehearsal** against a copy of the production DB before
   cutover — repeated until clean.
3. Scripted verification: row-count reconciliation per table pair plus
   spot-check queries (e.g. a known chat's history readable through the new
   schema), run automatically after every rehearsal and at cutover.
4. Full DB backup immediately before cutover; the old database is retained
   untouched (read-only) after cutover.
5. Written cutover runbook: stop old → backup → migrate → verify → start new
   → smoke-check (bot answers, dashboard loads, web chat works) → rollback
   path (restore backup, redeploy last v1 image).

## Build phases

Each phase gets detailed acceptance criteria in PROGRESS.md when it starts.

- **Phase 0 — Scaffold.** Turborepo + workspaces; current app moves into
  `apps/web`; `packages/db` / `core` / `contracts` carved out with no
  behavior change; CI, lint/typecheck/test/build wiring; docker builds both
  apps (image shape decided here: two images vs one image, two entrypoints).
- **Phase 1 — Schema + migration.** Canonical identity, assistants,
  connections, tool-connection tables in `packages/db`; migration scripts +
  verification harness + rehearsal workflow.
- **Phase 2 — Worker split.** Bot runtime, schedulers, jobs, pipeline, MCP
  runtime move to `apps/worker`; Redis bus + queue; SSE bridged in
  `apps/web`; dashboard controls go through desired-state + bus.
- **Phase 3 — Assistants.** CRUD UI, personality conversion, per-assistant
  telegram connections with concurrent pollers, per-assistant tasks,
  own-name addressing + bot-to-bot rules.
- **Phase 4 — Web chat.** Threads UI (create/name/pick assistant), text +
  image upload + voice, live turn progress, message-at-once delivery,
  history/memory/trace parity with telegram chats.
- **Phase 5 — MCP connections.** HTTP connections CRUD, discovery +
  snapshot/apply, scoping, prefixing, tools dashboard rework.
- **Phase 6 — Cutover.** Rehearsed migration, runbook execution, rename,
  release pipeline for the new shape, docs rewrite (AGENTS.md describes v1
  and must be updated).

Out of scope for v2 (planned, not built): stdio MCP execution, per-assistant
toolset selection, end-user accounts / self-serve tools, token streaming,
Signal, mobile apps.

## Open items

- **New repo/product name** — rename decided, name not chosen yet.
- **Bot-to-bot loop guard** — with `from_bot` ignoring relaxed between
  assistants, two assistants addressing each other can ping-pong forever.
  Needs a designed guard (e.g. a cap on consecutive bot-to-bot turns per
  chat). Proposal pending user review.
- **Queue retry semantics** — exact idempotency/dedupe rules for inbound
  turn jobs (no double replies, no lost messages).
- **Image shape** — one image with two entrypoints vs two images (Phase 0
  decision, affects the release pipeline).
