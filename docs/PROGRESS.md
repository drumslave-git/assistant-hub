# v2 Redesign Progress

Working tracker for the redesign described in [PLAN.md](PLAN.md). Statuses:
`todo`, `in-progress`, `blocked`, `done`, `deferred` — same rules as
[TODO.md](TODO.md) (proof for `done`, blocker + next decision for `blocked`).
Per user decision (2026-08-21), redesign progress lives here, not in TODO.md.

## Current state

Phases 0 (scaffold) and 1 (schemas + migration) are done on the long-lived
`redesign` branch (created 2026-08-21 from main at the tracing-unification
commit).

Phase 2 is in progress: boundary study done, the source-app event
contract and the Redis bus/queue foundation are built and tested (see the
Phase 2 criteria below). Next best task — the runtime extraction, in this
order:

1. Design tg's internal API surface first (the boundary study shows core
   will need: media bytes for vision/voice transcription, summaries
   read/write, search read/write, mirror writes for `recordReply` — plus
   the operator listing/CRUD API). The vision/voice split is the tricky
   part: media NORMALIZATION (sharp/ffmpeg) moves to tg with ingestion,
   media DESCRIPTION (LLM) stays core and reads bytes through tg's API.
2. Build the apps/tg runtime additively (poller from connections, mirror
   + ingestion into its store, owner resolution, inbound events with
   context onto the queue, reply-delivery + lifecycle consumption) while
   core keeps running v1 — the swap is its own later commit.
3. Rewire core: queue consumer around `handleIncomingMessage` with
   source-agnostic deps, actions-started marker, then delete
   `server/telegram` and re-route its consumers (list in the boundary
   study).

Phase 2 mechanics decided (user, 2026-08-23): **Hono** for the tg
service's HTTP surface (operator API + MCP endpoint); the **two-step
extraction** (build apps/tg additively while core runs v1, then one swap
commit deletes `server/telegram` and re-routes its consumers); internal
core↔tg auth via a shared-secret header (`INTERNAL_API_TOKEN` on both
sides). For apps/chat the user asked whether it must be Next.js —
standing recommendation (final call at Phase 4): no; its UI renders
inside the core dashboard's Next build via `apps/chat/ui` (PLAN's
micro-frontend decision), so the chat backend is a pure service and Hono
keeps it tg's twin. A standalone chat frontend outside the dashboard
would reopen that.

The open questions were answered by the user (2026-08-22) and applied:

1. **Queue retry semantics**: confirmed — BullMQ `attempts: 1`; the turn
   runner alone decides re-enqueue via the "actions started" marker.
2. **Placement rule (strict)**: bot state (memory, self-improvement,
   tasks, job coverage markers like chat_summary_days /
   memory_extraction_days) → **core** store; conversation-derived content
   (messages, message_search, media, **chat summaries**, feedbacks) →
   the **owning app's** store — "core just provides tools and features".
   Consequence for Phase 2: core jobs (summarization, search indexing,
   vision describe) read and write app content through the owning app's
   API.
3. **Owner**: owner logic and settings live on the app side (tg-store
   settings singleton holds owner_username / owner_user_id); the core
   receives only the resolved is-owner flag on inbound events.
   `maintenance_mode_enabled` stays core (the gate consuming the flag).
4. Naming confirmed as explained: `@assistant-hub/*` package scope ahead
   of the Phase 6 repo rename; per-app v2 database modules in
   `<app>/store/`; core's transitional `STORE_DATABASE_URL`; assistants
   keep personality UUIDs.

Known pitfalls (in addition to the ones under "Phases" below):

- Local dev runtime data now lives under `apps/core/data` (traces,
  downloads, bin); only the Compose Postgres bind mount stays at the root
  `./data/pg`. The container equivalents moved to `/app/apps/core/data/*`
  because the standalone server chdirs into `apps/core`.
- `npm run <anything>` at the root fans out via turbo; per-app scripts run
  with `npm run <script> -w @assistant-hub/core`. The dev server and
  `.claude/launch.json` are unchanged (port 3200).

Known pitfalls for whoever starts:

- Work happens on the long-lived redesign branch, rebased onto main after
  hotfixes — never merge commits, never version bumps from the branch.
- The dev server on :3200 and the preview browser session have the usual
  constraints (see memory/AGENTS.md); Phase 0 moves files massively — expect
  to restart the dev server deliberately, not accidentally.
- Migration work (Phase 1) must never run against the production DB except
  through the rehearsal/cutover workflow in PLAN.md.

## Phases

| Phase | Scope (see PLAN.md) | Status |
| --- | --- | --- |
| 0 | Monorepo scaffold, apps/core + packages carve-out, extension registry, CI, docker | done |
| 1 | Per-app databases + schemas, scoped refs, person links, migration scripts + rehearsal | done |
| 2 | Source split: telegram runtime out of core into apps/tg, source contract, Redis bus + queue | in-progress |
| 3 | Assistants CRUD, per-assistant bots, tasks, addressing rules | todo |
| 4 | Web chat: apps/chat + chat-ui, threads, text/image/voice, live progress | todo |
| 5 | MCP connections (HTTP): CRUD, discovery, snapshot/apply, scoping | todo |
| 6 | Cutover: rehearsed migration, runbook, rename, release, docs | todo |

## Phase 0 — Scaffold (acceptance criteria)

Scope from PLAN.md: Turborepo + npm workspaces; the current app moves into
`apps/core` unchanged; `packages/db` / `packages/contracts` / `packages/ui`
carved out with no behavior change; the extension-registry skeleton in the
shell; lint/typecheck/test/build wiring through turbo; docker builds the
per-app images (only `core` exists yet) and the release pipeline publishes
them all from one root version bump.

- [x] Root is a Turborepo workspace (`turbo.json`, root `package.json` with
      `workspaces`, shared `tsconfig.base.json`); `npm run lint|typecheck|
      test|build` at the root fan out via turbo and pass.
- [x] The whole current app lives in `apps/core` (moved with `git mv`, no
      rewrites beyond config paths); `npm run dev` still serves the
      dashboard on :3200; `@/*` imports unchanged.
- [x] `packages/db` (`@assistant-hub/db`) holds the generic Postgres/drizzle
      tooling (process-global pool singletons keyed by symbol, the
      production migration runner formerly in `docker/migrate`);
      `apps/core/db/pool.ts` consumes it with the same symbol key and
      identical behavior. App schema, drizzle handle, and migration chain
      stay in `apps/core`.
- [x] `packages/contracts` (`@assistant-hub/contracts`) exists as the
      documented home for cross-app schemas (source-app contract, scoped
      refs — content lands in Phases 1–2; deliberately exports nothing yet).
- [x] `packages/ui` (`@assistant-hub/ui`) holds the typed extension-point
      definitions (`AppExtensions` with nav contributions now; form
      sections / status cards / debug panels / aggregated views typed as
      their first contributor lands) plus `composeNavGroups`; the shell's
      `NAV_GROUPS` composes from the static registry in
      `apps/core/components/layout/extensions.ts` (empty today) — rendered
      nav identical.
- [x] Docker: `apps/core/Dockerfile` builds `assistant-hub-core` from the
      repo-root context (workspace-aware install, Next standalone monorepo
      output with `outputFileTracingRoot`, migrate runner from
      `packages/db/migrate`, runtime data at `/app/apps/core/data/*`); root
      `docker-compose.yml` and `docker-compose.test.yml` updated.
- [x] Release pipeline: `.github/workflows/release.yml` verifies via turbo
      and, on a root version change on main, tags once and builds/pushes
      every per-app image (matrix; currently `assistant-hub-core`) on that
      one version. (Cannot fire from the branch — by design, no version
      bumps until cutover; verified by review only.)
- [x] Proof (2026-08-21, all from the root): `turbo run typecheck` 4/4
      workspaces green; `turbo run lint` green; `turbo run test` 1163
      passed / 26 skipped; `turbo run test:integration` 367 passed / 33
      skipped (Testcontainers); `turbo run build` green (standalone output
      verified: `apps/core/server.js` + root `node_modules` + traced
      playwright). `docker build -f apps/core/Dockerfile .` succeeded
      (1.83GB) and the container booted: migrate runner ran (skipped
      without DATABASE_URL), standalone server started from
      `apps/core/server.js`, failed only on the intentional missing-DB
      guard — same as v1 without a database. Dev server boots through
      turbo (env loaded from `apps/core/.env`, DB + bot poller up, /login
      200, no server errors).

`npm run test:linux` verified on the new layout (stale volume dropped,
fresh workspace install, 1189/1189 tests in 105 files — including the
subprocess tests that skip on Windows).

Remaining risks: the release workflow is updated but unexercised (it can
only fire from main — by design, no version bumps from the branch until
cutover). The standalone build locally traces in `apps/core/data`
and test files — harmless in the image because `.dockerignore` excludes
them from the build context. Docs under `docs/` still describe the v1
layout except README and `docs/operations/deployment.md`, which were
updated; the full docs rewrite is Phase 6 by design.

## Phase 1 — Schemas + migration (acceptance criteria)

Scope from PLAN.md: per-app databases and schema modules (core, tg, chat);
scoped-ref and person-link foundations; migration scripts splitting the v1
DB + verification harness + rehearsal workflow. The v1 runtime keeps
running on the v1 schema untouched — the new stores exist beside it and
take over feature by feature in Phases 2–5.

Conventions set here: each app's v2 database module lives in
`<app>/store/` (schema.ts + migrations/ + drizzle config) — `apps/core/db`
stays the v1 module until cutover deletes it. Fresh databases, fresh
migration chains, clean table names. Store DB URLs come from each app's
own env (`DATABASE_URL` in apps/tg and apps/chat; `STORE_DATABASE_URL` in
apps/core while v1 still owns `DATABASE_URL`). Import scripts read the v1
DB via `V1_DATABASE_URL` with plain SQL (no code dependency on the v1
schema module) and refuse a non-empty target.

- [x] `@assistant-hub/contracts` exports the scoped-ref foundation
      (`source:kind:id` — format, parse, zod schema, source ids) and the
      shared `EMBEDDING_DIMENSIONS` constant (moved from `lib/embeddings`,
      which re-exports it); unit tests cover parse/format round-trips.
- [x] `apps/core/store`: core-store schema + 0000 migration — backends,
      settings (v1 minus `telegram_bot_token` / `active_personality_id` /
      owner columns), assistants, memory (entries / user docs by scoped
      ref / general), communication_preferences, self_corrections,
      addressing_exclusions, tasks (scoped refs + `assistant_id`), job
      coverage markers (chat_summary_days + memory_extraction_days,
      scoped chat refs), person_links + person_link_members (unique
      member ref).
- [x] `apps/tg/store`: tg-store schema + 0000 migration — users, chats,
      chat_members, messages, message_search, media, media_blobs,
      feedbacks, summaries (conversation-derived content lives with the
      mirror — user decision 2026-08-22), connections (bot token per
      assistant, desired state), settings singleton (owner identity).
      Hand-written extension/index SQL (vector, pg_trgm, FTS/trgm GIN)
      carried over from the v1 chain.
- [x] `apps/chat/store`: chat-store schema + 0000 migration — users
      (operator flag), threads (assistant bound at creation), messages,
      media + blobs.
- [x] Import scripts as one-shot per-app tools: `apps/core/store/import-v1.ts`
      and `apps/tg/store/import-v1.ts` (runnable via `npm run import:v1
      -w <app>`), splitting the v1 DB per the PLAN mapping, preserving
      identity ids, converting FKs to scoped refs, deriving the default
      assistant deterministically (active personality id, else the fixed
      `assistant-default`), and creating the tg connection from the v1
      bot token. Both refuse a non-empty target.
- [x] Verification harness built into each import script: per-table-pair
      row-count reconciliation plus spot checks; mismatch prints a report
      and exits non-zero.
- [x] Integration tests (Testcontainers): seeded synthetic v1 fixtures →
      run each import → verification passes and spot asserts hold; the
      chat store's migration chain applies cleanly.
- [x] Rehearsal workflow documented (docs/operations/v1-split.md): dump →
      restore copy → create per-app DBs (`packages/db` create-database
      helper) → migrate stores → run imports → read verification; repeat
      until clean. Production DB is never touched outside it.
- [x] Proof (2026-08-22, after the placement revision, all from the
      root): typecheck 6/6 workspaces green; lint green; unit tests green
      (contracts scoped-ref suite included); `turbo run test:integration`
      green with a real exit code — chat 1/1, tg 2/2 (full import
      round-trip: verbatim identity-preserved mirror and summaries,
      surviving embeddings and pending-media bytes, token bound to the
      converted active personality, owner in tg settings,
      non-empty-target refusal), core 369 passed / 33 skipped including
      the core import round-trip (settings minus dropped token/persona/
      owner columns, id-preserving assistants, scoped refs on
      memory/tasks/exclusions, identity-preserved day markers, sequence
      continuation, refusal); build green.

Remaining gaps, deliberate: the new workspaces (tg, chat, contracts, db,
ui) have no eslint wiring yet (typecheck guards them; lint config for
non-Next workspaces is a small standalone task). The tg import test
applies the frozen v1 migration chain via a cross-app path — test-only,
deleted with `apps/core/db` at cutover. Person links have schema +
foundations only; no UI/service until the aggregation phases.

## Phase 2 — Source split (acceptance criteria)

Scope from PLAN.md: the Telegram runtime moves out of the core into
`apps/tg` behind the source contract (inbound events with context,
reply-delivery events, listing API, tg MCP server); Redis bus + queue; the
pipeline consumes the queue; dashboard controls go through tg's operator
API + bus. Decisions applied: BullMQ `attempts: 1` with the turn runner
deciding re-enqueue via the actions-started marker; conversation-derived
content is written/read through the owning app's API; the source resolves
and stamps `senderIsOwner` on inbound events.

- [x] Boundary study (2026-08-22). The seam already exists:
      `handleIncomingMessage` takes injected `BotMessagingDeps`, which
      split cleanly into **source-supplied** (loadHistory 24h window,
      loadChatContext participants/roster, loadCurrentTurn transcript
      line + reply target incl. quote, loadVision media notes,
      sendReply/sendVoiceReply, recordReply mirror write, startTyping →
      lifecycle events, policy owner/maintenance) and **core-owned**
      (generateReply, analyzers, loadMemory, loadSenderPreferences,
      exclusions, persona/self-correction/tasks blocks, time/language
      context, trace). The telegram runtime to move is
      `apps/core/server/telegram/*` (~1.6k lines: process-update,
      bot-manager, transport, process-reaction/callback) plus media
      ingestion. Outside consumers of that dir — the full list of seams
      to re-route: instrumentation.ts (boot), app/api/telegram/bot
      (dashboard control → tg operator API), dashboard layout/page (bot
      status), bot-messaging mcp-tools (outbound sends → tg MCP server),
      image-gen deliver + browser-agent runner + tasks scheduler
      (deliveries → reply-delivery events / tg MCP tools),
      server/mcp/context, test/simulate. Note: reactions/callbacks
      (feedback flow) become tg-local now that feedbacks live in the tg
      store, with a bus event feeding core's reflection/folding jobs —
      its event shape gets designed during extraction, not up front.
- [ ] `packages/contracts`: the source-app contract — inbound message
      event (scoped refs, resolved `senderIsOwner`, conversation context:
      history window + participants + chat metadata), reply-delivery
      event, turn-lifecycle events (accepted / progress / settled), bus
      event envelope, queue names/payloads; the listing/CRUD API shapes
      the dashboard aggregates.
- [ ] Redis infrastructure: compose service (dev + prod), `packages/bus`
      (BullMQ queue helpers with `attempts: 1`; pub/sub with typed
      envelopes); integration-tested against a real Redis.
- [ ] `apps/tg` runtime: poller(s) from tg-store connections, inbound
      persistence (mirror, media ingestion) in its own store, normalized
      inbound events with context onto the queue, reply-delivery
      consumption → send, lifecycle events → typing indicator, owner
      resolution from its settings, MCP server for outbound actions,
      operator listing/CRUD API for its entities.
      **Slice A landed (2026-08-23, `c41e6b7`)**: the service runs —
      poller lifecycle ported (tokens from connections), text-turn
      inbound processing (mirror + hold, owner resolution, composed
      context, one validated event per message, idempotent), delivery +
      lifecycle consumers (send → mirror; typing accepted→settled;
      settle releases the hold), Hono `/health` + `/internal/*` with the
      shared token, graceful shutdown; 5 integration tests green against
      real Postgres + Redis. Contract grew what the port surfaced:
      connection identity (bot username/display name), reply-target
      `stored`/`fromAssistant`, lifecycle `threadId`.
      **Remaining slices**: (B) media/voice ingestion + internal media
      API; (C) core queue consumer wiring `handleIncomingMessage` from
      the event (additive, v1-backed services); (D) feedback flows +
      MCP outbound tools + operator API; then the swap. Known slice-C
      surgery point: post-split the core never learns the delivered
      message id (delivery is an event) — `recordReply` becomes tg's
      mirror-on-delivery, and id-dependent core paths (browser ack,
      reaction targets) move source-side with the outbound tools.
- [ ] `apps/core`: telegram code removed; the pipeline consumes the
      queue; deterministic replies published as reply-delivery events;
      turn-lifecycle events published; the actions-started marker gates
      retry; core features that touch tg content (history tools,
      summarization, search indexing, vision describe) go through tg's
      API; dashboard telegram controls proxied to tg's operator API; the
      SSE layer bridges Redis pub/sub.
- [ ] Trace client: apps record through the shared client over the bus;
      the core persists all traces (PLAN "Traces and debug");
      correlation ids tie a turn's cross-app flow into one trace.
- [ ] Docker: `assistant-hub-tg` image + compose service + release-matrix
      entry; both apps boot together in compose.
- [ ] Tests at each seam; lint/typecheck/test/build green from the root;
      proof and risks recorded.

## Session log

- **2026-08-21** — Brainstorm session: all core decisions made by the user
  (monorepo/Turborepo, web+worker apps, Redis, canonical identity,
  assistants, web chat shape, MCP HTTP-only v1, big-bang on a rebased
  long-lived branch, brain-only migration with mandatory rehearsal).
  PLAN.md and PROGRESS.md created; TODO.md entry reduced to a pointer.
  Open: repo name, bot-to-bot loop guard, queue retry semantics, image
  shape.
- **2026-08-21 (later)** — Name decided: **assistant-hub**. Bot-to-bot loop
  guard approved: cap on consecutive assistant-authored turns per chat,
  operator-configurable. Remaining open items: queue retry semantics
  (Phase 2), image shape (Phase 0).
- **2026-08-21 (later still)** — Final two decisions: turn failure handling
  and deployment as two Docker images (`assistant-hub-web`,
  `assistant-hub-worker`) published together from one version bump. Turn
  handling was first agreed as ACID-like compensation, then revised by the
  user the same day to the simpler rule: retry only if the turn performed
  no actions yet; otherwise fail, report, stop — no revert machinery.
  Planning is complete.
- **2026-08-21 (evening)** — Topology revised by the user: **three** runtime
  apps, not two. `apps/tg` becomes a dedicated Telegram source app (pollers,
  inbound events, media ingestion, own MCP server with send_message /
  send_reply / typing tools); the worker keeps the pipeline and has no
  Telegram code. A formal source-app contract goes into packages/contracts
  (web chat and future sources implement the same shape). Reply path:
  deterministic replies travel as bus events the source app delivers;
  model-driven sends use the source app's MCP tools. Deployment becomes
  three per-app images.
- **2026-08-21 (night)** — Two more user revisions. (1) Web chat becomes
  its own source app, `apps/chat`, same contract as tg; `apps/web` is a
  pure dashboard shell + API + auth + SSE bridge + proxy, no longer a
  source. (2) The dashboard goes micro-frontend: app-owned UI packages
  (tg-ui, chat-ui) inject typed extensions (nav/routes, assistant-form
  sections, status cards) into the shell via a build-time extension
  registry (chosen over runtime module federation); source-app operator
  APIs are reached through the apps/web proxy on a single origin. Images:
  four. PLAN.md also rewritten this session as a history-free source of
  truth.
- **2026-08-21 (late night)** — Data model inverted by the user: canonical
  core entities are dropped in favor of **federation** — each app owns its
  own storage (its own logical database, schema, and migration chain):
  tg owns telegram users/chats/messages/media/connections, chat owns
  threads/messages, worker owns the core store (assistants, memory,
  tasks, settings, tool connections), web owns only sessions/prefs. The
  worker never reads a source's store — the source supplies conversation
  context (history window, participants) with the inbound event or on
  demand. Cross-app references are scoped refs (tg:chat:123); the same
  human across sources is joined by an operator-managed person-link table
  in the core store, which memory resolves through. The dashboard
  aggregates users/chats/messages via a shared listing/CRUD contract each
  source app's operator API implements. Migration now splits the v1 DB
  into the per-app databases.
- **2026-08-21 (later)** — apps/web and apps/worker merged into a single
  **apps/core** (user): with the sources carved out, the worker was just
  the brain and the web app just the shell, and the user wants the core
  store owned by the dashboard-owning app — so one hub app owns dashboard
  + auth + SSE + proxy + pipeline + MCP runtime + schedulers + core
  store, with no internal worker API needed. Three apps, three images
  (core/tg/chat). Phase 2 becomes "source split" (extract telegram from
  core) instead of a web/worker split.
- **2026-08-21 (last)** — Four refinements (user): typing is not an MCP
  tool — the core publishes turn-lifecycle events (accepted / progress /
  settled) and each source renders them natively (tg typing indicator,
  web thread progress); the chat app owns its own users (operator gets a
  chat user, linkable via person links); and the dashboard UI packages
  move inside their apps (apps/tg/ui, apps/chat/ui) as the one sanctioned
  seam the shell composes at build time.
- **2026-08-22 (Phase 2 start)** — Acceptance criteria written; boundary
  study done (the injected `BotMessagingDeps` seam splits cleanly —
  inventory in the criteria). Source-app event contract landed in
  contracts (inbound with context + resolved isOwner, reply-delivery,
  turn lifecycle, queue/channel names) and `@assistant-hub/bus` built on
  BullMQ/ioredis with the decided `attempts: 1` semantics — both tested,
  the bus against a real Redis (exactly-once, failure stays failed,
  poisoned pub/sub message survives). Compose gained the `redis` service
  (AOF + volume). Feedback/reaction bus events deliberately deferred to
  the extraction (their consumers shape them). Next: tg internal API
  design, then the additive runtime build (see Current state).
- **2026-08-22 (Phase 1 revision)** — User answered the open questions and
  the stores were reworked to match before Phase 2: the strict placement
  rule (bot state → core; conversation-derived content → owning app;
  "core just provides tools and features") moved chat summaries into the
  tg store (`summaries`, plain telegram ids, identity-preserving import);
  the job coverage markers (chat_summary_days, memory_extraction_days)
  stay core as job state (user choice on the follow-up question). Owner
  identity moved out of core settings into a new tg-store settings
  singleton (user choice: app-level, not per-connection) — the core will
  receive only the resolved is-owner flag on inbound events;
  `maintenance_mode_enabled` stays core. Queue retry semantics confirmed:
  BullMQ `attempts: 1`, re-enqueue decided by the turn runner via the
  actions-started marker. Both 0000 migrations regenerated; imports,
  verification and integration tests updated.
- **2026-08-21/22 (Phase 1)** — Phase 1 executed and verified: scoped-ref
  foundation + shared `EMBEDDING_DIMENSIONS` + `DEFAULT_ASSISTANT_ID` in
  `@assistant-hub/contracts`; three store modules with fresh migration
  chains (`apps/core/store`, `apps/tg/store`, `apps/chat/store` — apps/tg
  and apps/chat created as store-only workspaces, runtimes land in Phases
  2/4); person_links + members in the core store; one-shot per-app import
  scripts with the built-in count-reconciliation + spot-check harness
  (plumbing shared via `@assistant-hub/db/import`, Testcontainers helpers
  via `/testing`); rehearsal workflow documented in
  docs/operations/v1-split.md with a create-database helper. Placement
  calls made in-session and flagged for user confirmation (see Current
  state): summaries/day-markers/exclusions → core with scoped refs;
  message_search/feedbacks → tg; both import scripts derive the default
  assistant identically (active personality id, else `assistant-default`).
  Notable fix: tg 0000 migration needed the messages unique index moved
  above the composite FKs (drizzle-kit orders indexes after constraints).
- **2026-08-21 (Phase 0)** — `redesign` branch created; Phase 0 executed
  and verified in one session: Turborepo + npm workspaces, the whole app
  `git mv`-ed into `apps/core`, `@assistant-hub/db` / `contracts` / `ui`
  carved out (pool singleton + migration runner; documented empty
  contracts; extension-point types + `composeNavGroups` with an empty
  registry composed into the shell nav), per-app Docker image
  (`assistant-hub-core`, monorepo standalone) and the release workflow
  reshaped to a tag-once + per-image matrix on the root version. Full
  proof under the Phase 0 acceptance criteria above. Naming decision made
  in-session: workspace packages use the `@assistant-hub/*` scope ahead of
  the Phase 6 repo rename; the root package keeps the v1 name/version so
  build info and the release trigger are unchanged until cutover.
- **2026-08-21 (traces)** — Tracing unified (user): the core owns all
  trace storage and provides the recording functions; apps record through
  a shared trace client that delivers events to the core over the bus.
  Replaces per-app trace stores and cross-store stitching — the debug
  explorer reads one store, correlation ids still tie a turn's cross-app
  flow into one trace.
