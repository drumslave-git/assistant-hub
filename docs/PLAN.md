# assistant-hub — v2 Redesign Plan

The source of truth for the v2 target architecture. Progress and phase
status live in [PROGRESS.md](PROGRESS.md); the pointer entry is in
[TODO.md](TODO.md). This document describes the target as designed — it is
updated in place when the design changes, and carries no decision history
(the session log in PROGRESS.md does).

Revised 2026-08-30: the per-app-storage architecture built in phases 2–5
was superseded by user decision. Core and chat merge, all data moves into
one core-owned store, transports become stateless, and the platform gains
multi-user accounts. Phases 0–5 remain the as-built history; the revised
target below is what phases 6–10 build.

## Vision

The Telegram bot becomes one connectable transport on top of a general
assistant platform named **assistant-hub**. The generic foundation —
pipeline, memory, tools, traces, dashboard, web chat — is the product;
Telegram and any future transport (Signal, mobile apps) are interchangeable
stateless transport apps that plug into it **without any core changes**.

Three pillars:

1. **One store, stateless transports** — the core owns every piece of
   data: users, chats, messages, media, memory, config. A transport holds
   no database; it normalizes platform traffic into events and performs
   sends. Adding Signal means deploying one new container, nothing else.
2. **Multi-user** — accounts with two roles, `admin` and `user`. Admins
   run the platform; users get the web chat plus their own data, and can
   create their own full-parity assistants (own personas, own bot tokens,
   own tools).
3. **Assistants** — a first-class entity: many assistants sharing one
   brain (LLM backends, settings, memory), each with its own persona,
   transport connections, tasks, and tool selection — and each with an
   owning account.

## Architecture

### Monorepo

Turborepo with npm workspaces. `apps/*` never import each other's code —
only packages.

```
apps/
  core/       Next.js — the product. Dashboard + multi-user auth + web
              chat + SSE, and the brain: reply pipeline, LLM loop, MCP
              runtime, schedulers, background jobs, Playwright, media
              pipelines (vision, voice). Owns THE store: accounts,
              assistants, settings, memory, tasks, tool connections,
              identity links, transport registrations and connection
              config, all conversation data (chats, messages, media)
              from every transport, web threads, and all traces.
packages/
  db/         Database tooling for the core's store: drizzle helpers,
              migration runner, repository conventions.
  contracts/  Zod schemas shared across apps: the transport contract
              (registration, events, delivery, link codes), queue
              payloads, bus events, scoped refs, API DTOs.
  transport-sdk/  The published package a transport is built on: the
              wire half of the private packages, as built output.
  ui/         Shared dashboard components.
```

Transports are not workspaces here. Each is its own repository and its own
image, built on `transport-sdk` — the Telegram one (one grammY poller per
enabled connection, media fetching, update normalization, reply delivery,
typing, and an MCP server for Telegram's outbound actions) is
`assistant-hub-swarm/ahw-transport-telegram`. None has a database.

Domain logic lives inside `apps/core`; only genuinely cross-app code is a
package. The build-time extension registry from the original design is
retired: transports contribute dashboard UI through published config
schemas (see Dashboard), not compiled-in UI packages, so a transport ships
no UI package at all.

### Runtime topology

```
Browser ── HTTP/SSE ── apps/core ──┬── LLM endpoint(s)
                          │        ├── remote MCP servers (HTTP)
                          │        ├── transport MCP servers (tg, …)
                          │        └── Playwright / media pipelines
                          │
Telegram ─ pollers ─ transport ── Redis (queue + pub/sub) ── apps/core

(transports: inbound events out, reply-delivery + lifecycle events in;
 each hosts an MCP server for its platform's outbound actions)

One Postgres database (core's). Transports have none.
```

Web chat has no transport app: it is a core feature, served and stored by
`apps/core`, its turns entering the pipeline in-process.

### Data ownership

The core owns all storage. Conversation data from every transport lands in
generalized core tables — platform users, chats, messages (all kinds),
media — keyed by **scoped refs** (`tg:chat:123`, defined in
`packages/contracts`) with platform-specific detail carried as opaque
metadata, never as telegram-shaped columns. The core composes conversation
context (history window, participant roster) from its own store; no
transport is ever asked for history.

Transport configuration also lives in the core store, but as **opaque
per-transport sections** the core never interprets: an assistant's record
carries a config blob per transport (the Telegram section holds the bot
token and connection settings), validated and rendered against the schema
the transport publishes at registration. Transports receive their desired
state (their connection list with config) from the core at boot and on
change events, and publish actual state back. A transport holds nothing
durable of its own.

### The transport contract

`packages/contracts` defines what any transport is, and
`packages/transport-sdk` publishes it: an author installs one package
(built output, with the private packages bundled in) or reads the
generated JSON Schema and OpenAPI under `docs/api/transport/` and speaks
Redis and HTTP directly. The design goal is hard: **a new transport
connects to a running core with zero core changes**, from its own
repository, in any language.

A transport:

- **self-registers** at boot over the internal API/bus with a shared
  secret: its id, display name, config schema (for the assistant-editor
  connection section), and MCP endpoint. It appears in the dashboard,
  where an admin enables it;
- **forwards everything**: every message (addressed or not — group
  chatter builds context), edit, deletion, and membership change becomes
  a normalized inbound event the core persists. It fetches media bytes
  itself (only the transport talks to its platform's API) and hands them
  to the core with the event;
- **consumes reply-delivery events** for its chats and performs the
  actual send. It degrades unsupported payload kinds itself (a transport
  that cannot send a kind notes or drops it) — the contract carries no
  outbound capability flags;
- **renders turn-lifecycle events** natively: the core publishes
  accepted-for-processing, progress, and settled for every inbound
  message; tg turns them into the Telegram typing indicator;
- **hosts an MCP server** for its platform's outbound actions. Tools are
  the capability surface: a platform with reactions offers a reaction
  tool, one without simply doesn't. The core gates nothing on "is this
  telegram";
- **relays identity-link codes**: a one-time code a person sends to the
  bot is reported to the core, which links the platform identity to the
  account that minted the code;
- **reconciles**: it applies desired connection state from the core
  (start/stop pollers) and publishes actual state.

There are no capability flags anywhere in the contract. The core supports
all media kinds natively; typing is lifecycle rendering; platform actions
are MCP tools.

The Telegram transport (`assistant-hub-swarm/ahw-transport-telegram`) is
the first implementation; adding Signal later means writing another
transport on the SDK, publishing its image, and adding one service to the
operator's compose file.

The wire has one number both sides must agree on: `CONTRACT_MAJOR`,
announced at registration. A core that speaks another major refuses the
transport by name with a reason its dashboard shows — never a silent
drop. The SDK's own semver is separate, and covers its API.

### Message flow

- **Inbound (transport):** the transport enqueues one normalized event
  per update; the core persists it and — when it is a message that opens
  a turn — runs the pipeline. **Inbound (web chat):** the message is
  stored and the same pipeline runs in-process; no transport hop.
- **Outbound, deterministic:** the finished reply is published as a
  reply-delivery event; the owning transport performs the send. Web-chat
  replies reach the browser through the SSE layer directly. The model
  never has to remember to send its own answer.
- **Outbound, model-driven:** task fires and cross-chat sends are tool
  calls into the transport's MCP server; web-chat outbound tools are
  in-process core tools.
- **Events:** transports and core publish status/progress events on Redis
  pub/sub; the core bridges them to SSE (the
  `publishEvent`/`useLiveRefresh` contract).
- **Control:** dashboard edits write to the core store; the core emits
  change events; transports reconcile and publish actual state.

### Dashboard

One Next.js app, one origin. Role-aware: admins see everything; users see
the web chat and their own data (see Accounts). Transport-specific UI is
**schema-driven**: the connection section a transport contributes to the
assistant editor is rendered from the config schema it published at
registration (labels, types, secret fields), so a new transport gets its
dashboard surface for free. No build-time UI composition, no extension
registry, no proxying to transport operator APIs — the dashboard reads and
writes the core store in-process.

### Turn failure handling

Unchanged: no revert machinery. A failed turn retries only if it performed
no actions yet; once any action has run, a failure reports to the trace
and dashboard and stops. Transient failures before any work never drop
messages; nothing double-sends or double-executes.

## Domain model

### Accounts and roles

DB-backed accounts with username + password (hash in the core store) and
a role: `admin` or `user`. First-run `/setup` creates the first admin
(superseding the single operator password). Admins create further
accounts (or invite links); there is no open registration. Sessions stay
stateless signed cookies, now carrying the account and signed per-account
so a password change invalidates that account's sessions only.

- **admin** — everything: settings, LLM backends, transports, all
  assistants, all conversations, all traces, tool-connection registry,
  account management.
- **user** — the web chat plus their own data: their threads; their own
  assistants and everything those assistants do (their telegram chats and
  messages, web threads, tasks, and those turns' traces); their profile
  and identity links; the memory held about them (view + delete — no
  self-authoring). Nothing global, nothing of other users'.

**Identity links:** the account is the person anchor. A user mints a
one-time code in their profile and sends it to a bot; the transport relays
it and the core links that platform identity to the account. Admins can
also link/unlink manually. Memory and owner-rights resolution read through
these links.

**Offboarding:** deactivation blocks sign-in, disables the account's
assistants, and stops their pollers — data intact, reversible. Hard delete
exists behind a confirm and cascades: assistants, connections, threads,
and the account's person memory.

**No per-user quotas.** Local LLM, trusted accounts; nothing in the schema
anticipates limits.

### Assistants

Owned by the core store; every assistant has an **owning account**. Many
assistants sharing one brain: LLM backend config, settings, and the memory
store are shared. Per-assistant: persona, transport connections (opaque
config sections, e.g. a bot token), standing tasks, and tool selection.

Users create their own assistants with **full parity**: a user's assistant
can have its own telegram bot token, tasks, and tool selection, exactly
like an admin's. It is visible and usable only to its owner (and admins).

**Owner rights in a turn:** the sender holds owner rights iff their
account (resolved through identity links) is the assistant's owning
account. Admins hold owner rights on every assistant. This replaces the
single global owner identity.

Behavior in shared chats is unchanged: assistants answer to their own
name only, and the deterministic bot-to-bot loop guard (operator-set N,
default 3) silences assistants after N consecutive assistant-authored
turns until a human speaks.

### Conversation pipeline

The turn runner is source-agnostic: addressing (deterministic own-name
check per assistant + analyzer), policy gates, prompt composition (system
+ persona + chat context + memory + history + current turn — all composed
from the core's own store), tool loop, honesty gate, delivery, trace. One
job per inbound message, with the turn-failure rules above. Trace events
double as progress events on the bus.

### Memory

Core-owned, shared across assistants, in two scopes:

- **global** — facts about the world and the household, injected into
  every turn;
- **per-person** — keyed to an account (or an unlinked platform
  identity), injected into a turn **based on the chat's members**: a
  group turn carries the memory of the people in that chat; a web thread
  carries its owner's.

A user sees and can delete their own per-person entries; creating and
editing stays with the bot and admins.

### Web chat

A core feature — no separate app, no separate store. Named threads belong
to accounts; each thread is bound to one assistant at creation (no
mid-thread switching). Full modality: text, image upload (vision
pipeline), voice both directions. Delivery is message-at-once plus live
turn progress over SSE (typing / tool activity), not token streaming.

### MCP tool connections

Stored in the core store, with an **owning account**:

- **Admin-owned connections** work as today: HTTP transport (Streamable
  HTTP + legacy SSE) with auth headers, discovery + snapshot/apply,
  scoping along global / per-app / per-assistant dimensions,
  slug-prefixed tool names. Unrestricted endpoints.
- **User-owned connections**: a user may register their own HTTP MCP
  connections — running on their own infrastructure — scoped to their own
  assistants only. Because the core makes the calls, user-owned
  connections may target **public addresses only**: private ranges
  (RFC1918, localhost, link-local) are rejected at connect and at call
  time.
- stdio stays modeled but disabled, admin-side only.

Transport MCP servers (tg's outbound actions) are managed connections the
core provisions from transport registrations, scoped per-app so a
platform's tools appear only on its own turns. Built-in feature tools
(browse_web, memory, tasks, image-gen, web-chat outbound, …) remain an
in-process registry.

The offered toolset stays a snapshot that changes only on explicit apply —
never mid-conversation (llama.cpp prefix-cache stability, strict-provider
schema drift).

### Traces and debug

Unchanged in mechanism: every trace lands in the core store via the trace
client, correlation ids tie a turn's flow across apps into one trace. New
in visibility: a user sees the traces of their own assistants' turns;
everything else is admin-only.

## Migration ("migrate the brain, drop the logs")

Hard requirement: **no brain-data loss**. Downtime at cutover is
acceptable. The v1 database migrates into the **single core store** (the
per-app split from the original design is void — transports get nothing):

- telegram users/groups, message history, media/vision descriptions →
  the core's generalized conversation tables under `tg:` scoped refs;
- memory, sender preferences, self-improvement corrections, tasks,
  personalities → assistants, settings → the core's own tables;
- the operator password → the first admin account; the bot token → the
  telegram config section on the default assistant, owned by that admin.
- Out of scope (start fresh): traces, analytics rollups.

Mechanism and safety net (unchanged): one-shot migration scripts tested
against seeded fixtures; mandatory rehearsal against a copy of the
production DB until clean; scripted row-count reconciliation and
spot-checks after every rehearsal and at cutover; full backup immediately
before cutover with the old database retained read-only; a written
runbook with a rollback path (restore backup, redeploy last v1 image).

## Deployment

Docker images on the org's GitHub Container Registry:
`ghcr.io/assistant-hub-swarm/ahw-core` from this repository, and one per
transport from its own (`ahw-transport-telegram`, …), each named after its
repository. Each release pipeline builds and publishes on its own version
bump; compose pins every service to a version, the core's and each
transport's separately. Compose runs one Postgres database (core's) and one
Redis.

## Build phases

Phases 0–5 are done and describe the as-built history (per-app stores,
source contract, build-time UI extensions); see PROGRESS.md. The revised
target is built by phases 6–10. Each phase gets detailed acceptance
criteria in PROGRESS.md when it starts.

- **Phase 6 — Chat dissolve.** `apps/chat` merges into the core: its
  store into the core schema, its backend in-process, its outbound MCP
  tools become in-process core tools, its dashboard views become plain
  core pages; the app and its queue hop are deleted.
- **Phase 7 — One store, stateless transports.** The tg store moves into
  the core's generalized conversation tables; tg forwards everything
  (all messages, edits, deletions, membership) and hands media bytes to
  the core; context composition moves into the core; connection config
  becomes opaque sections on assistants with schema-driven forms
  replacing `ahw-transport-telegram's UI`; transport self-registration + reconcile over
  the bus; the transport contract replaces the source-app contract; tg's
  database is deleted.
- **Phase 8 — Accounts.** The users table, roles, sessions; first-run
  setup creates the first admin; account management UI; role gates across
  every page and API; assistants gain owning accounts and owner-rights
  resolution replaces the global owner; identity links with the
  self-link bot-code flow; memory rescoped (global + per-person by chat
  membership) with the user-facing view + delete.
- **Phase 9 — User ownership.** Users create full-parity assistants
  (persona, bot token, tasks, tools); user-owned MCP connections with the
  public-address guard; visibility scoping (own assistants' chats,
  threads, tasks, traces); offboarding (deactivate / cascade delete).
- **Phase 10 — Cutover.** Rehearsed migration into the final shape,
  runbook execution, rename to assistant-hub, release pipeline, docs
  rewrite (AGENTS.md describes v1 and must be updated).

Out of scope for v2 (planned, not built): stdio MCP execution, token
streaming, per-user quotas, Signal, mobile apps.

## Working rules

- Big-bang redesign: the full target is designed here first; intermediate
  states need not be shippable.
- All work happens on one long-lived redesign branch — the sanctioned
  exception to the commit-on-main rule. Main stays releasable for hotfixes;
  the branch is **rebased onto main** after hotfixes (rebases, not merges).
- No version bumps from the branch until cutover.
- Design changes are made by asking the user, then updating this document
  in place; the outcome is logged in PROGRESS.md's session log.
