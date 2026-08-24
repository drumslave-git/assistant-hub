# v2 Redesign Progress

Working tracker for the redesign described in [PLAN.md](PLAN.md). Statuses:
`todo`, `in-progress`, `blocked`, `done`, `deferred` — same rules as
[TODO.md](TODO.md) (proof for `done`, blocker + next decision for `blocked`).
Per user decision (2026-08-21), redesign progress lives here, not in TODO.md.

## Current state

Phases 0 (scaffold) and 1 (schemas + migration) are done on the long-lived
`redesign` branch (created 2026-08-21 from main at the tracing-unification
commit).

**Phase 2 is DONE** (2026-08-24): `apps/core/server/telegram` is deleted,
the tg app owns everything Telegram-shaped, the core reads/writes
conversation content only through tg's internal API, and the live
end-to-end smoke passed on the operator's real bot (see the swap notes
under the Phase 2 criteria for the commit-by-commit list, and the smoke
item below for the dev-environment setup that now exists). One standing
item carried forward: the slice-D **MCP-outbound design call** still
awaits user confirmation (REST send API + core-side tool bindings vs an
MCP endpoint on tg — Phase 5 can wrap the same handlers either way).

**Next: Phase 3 (Assistants).** Scope from PLAN: assistants CRUD UI +
personality conversion, per-assistant tg connections with concurrent
pollers (connection settings as an `apps/tg/ui` extension of the
assistant editor), per-assistant tasks, own-name addressing per
assistant + the bot-to-bot loop guard, aggregated users/chats pages +
person links. Acceptance criteria to be written at phase start, after
the sequencing decisions below are answered (they shape everything):

1. **Store flip scope** — the brain still reads the v1 database for
   persona (active personality), tasks, memory, settings. Per-assistant
   behavior cannot be expressed in v1's single-personality shape, so
   Phase 3 likely re-points the ASSISTANT-SCOPED reads (persona by
   `event.assistantId`, per-assistant tasks) at the v2 core store —
   which Phase 1 already built (`assistants`, per-assistant `tasks`) —
   while memory/settings/self-improvement stay v1 until Phase 6.
   Recommendation: yes, flip assistant-scoped entities now; keeping
   them v1 would make Phase 3 UI-only and force a second rework later.
2. **Loop-guard default N** — consecutive assistant-authored turns per
   chat before assistants go silent until a human speaks
   (operator-configurable, DB-backed). A default is needed.
3. **Dev-store population** — the core-store import script converts v1
   personalities → assistants; decide whether to run it into the dev
   `core` database now (so Phase 3 CRUD has real rows) the way the tg
   import just ran.

The old numbered list below records how the last Phase 2 items closed:

1. **Analytics re-route — done (`fe56e5f`).** The former flip blocker:
   every message-volume read (charts, top users, availability, the
   insight due-scan, hour transcripts, day topics) now goes through the
   tg content API (`/internal/analytics/*` + a `?date` summaries
   filter); the aggregation SQL lives tg-side pinned by a new
   integration suite, the due-scan is the summarizer's split-scan
   shape, and the core insight suite runs over the in-memory fake.
2. **Trace client over the bus — done (`8428ea7`).** The tg app records
   through the shared client in contracts (buffered whole-trace,
   published as `trace.recorded` on settle; unsettled = unpublished, so
   mirrored chatter stays silent) and the core ingests into the one
   trace store. Instrumented: inbound processing, feedback collection,
   reply delivery — each on the turn's correlation.
3. **Live end-to-end topology smoke — done (2026-08-24).** Dev topology
   stood up (databases `tg` + `core` created and migrated, `apps/tg/.env`
   written, compose Redis, shared `INTERNAL_API_TOKEN` in both `.env`
   files; tg store seeded from v1 settings — connection with the bot
   token under the active-personality assistant id, owner row) and the
   operator messaged the live bot: poller → mirror + hold → queue →
   core turn (full v1 prompt pipeline, LLM, honesty gate) → reply over
   the bus → tg send + assistant mirror row → hold released — and all
   three traces (tg `inbound`, core `reply`, tg `deliver`) landed in
   the one store under the single correlation `chat:message`, the
   cross-app trace client working live. One boot bug found only by the
   real boot (`666d133`): apps/tg needed `"type": "module"` — tsx
   inferred CJS and died on the entrypoint's top-level await, a failure
   every vitest suite masked by running the same files as ESM (the
   Docker CMD would have died identically).
   First smoke turn came back as the model's own reasoning; root cause
   found by diffing the request against a pre-swap trace: the prompt was
   byte-identical EXCEPT the history window — the fresh tg store had no
   mirror, so the turn ran with zero conversation history and gemma4-26b
   deliberated instead of replying. Resolved by running the designed v1
   import into the tg store (`import:v1`, source read-only: 1384
   messages, search index, media, summaries, feedbacks, users/chats,
   connection + owner; row counts reconciled, spot checks verbatim).
   Second live turn confirmed normal behavior by the operator. Dev note:
   the store was reset before the import (one-shot semantics), dropping
   only the two smoke rows.

One design call from slice D still awaits user confirmation
(MCP-outbound shape — see the slice D notes). The slice-C task-authority
swap blocker is resolved and landed (`ec2b7ad`): `event.sender.isOwner`
is authoritative, tasks stamp `created_by_owner` at creation (core
migration 0059 backfills), `BotPolicy` is maintenance-only.

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
| 2 | Source split: telegram runtime out of core into apps/tg, source contract, Redis bus + queue | done |
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
- [x] `packages/contracts`: the source-app contract — inbound message
      event (scoped refs, resolved `senderIsOwner`, conversation context:
      history window + participants + chat metadata), reply-delivery
      event, turn-lifecycle events (accepted / progress / settled), bus
      event envelope, queue names/payloads; the listing/CRUD API shapes
      the dashboard aggregates. Grown across the slices with the
      internal send/media API shapes, `feedback.recorded`,
      `dashboard.refresh`, and the content API (messages window/ids,
      import, day-counts, summaries, search, index).
- [x] Redis infrastructure: compose service (dev + prod), `packages/bus`
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
      **Also landed (67710d7)**: deterministic addressing is source-side
      — ported verbatim to apps/tg (unit-tested) and carried on the
      event (`addressing`); the core keeps only the LLM analyzer.
      **Remaining slices**: (B) media/voice ingestion + internal media
      API; (C) core queue consumer wiring `handleIncomingMessage` from
      the event (additive, v1-backed services); (D) feedback flows +
      MCP outbound tools + operator API; then the swap.
      **Slice D landed (2026-08-23, three commits)** — see the slice D
      notes below the slice C notes.
      **Slice C landed (2026-08-23)**: the core consumes the queue. The
      service seam (`IncomingMessage.message?`/`addressing?`, nullable
      delivered id), the shared `turn-bindings.ts` (generateReply +
      applyStandingTasks + classifier, extracted from process-update —
      one implementation for both paths), `server/turn/` (render:
      byte-identical v1 transcript/roster/current-turn from the event;
      actions: `turn_actions` markers in the v2 core store, migration
      0001; consume: deps-from-event, lifecycle publishing, per-chat
      ordering chain, retry policy), env-gated boot from register-node
      (REDIS_URL + STORE_DATABASE_URL). 6 integration tests prove:
      composed prompt parity, accepted→delivery→settled ordering,
      unaddressed turns settle without typing, generation failures
      deliver the v1 error notice (an action → handled, never retried),
      pre-action infrastructure failures re-enqueue without settling,
      acted/out-of-tries failures settle + rethrow. A live end-to-end
      topology smoke (tg poller → queue → core → bus → tg send with a
      real bot) is deliberately left for the swap slice — it needs the
      operator's environment.
      **Slice B landed (2026-08-23)**: media + voice cross the split.
      tg ingests every media message (detect/normalize/frames/download
      ported from the v1 vision feature — sharp in-process, ffmpeg
      sampling with thumbnail fallback, voice bytes raw), mirrors
      caption-less media as real turns, and serves the internal media
      API (`/internal/.../media`, `/internal/media/:id[/description]` —
      contract schemas in `@assistant-hub/contracts`, shared-token auth,
      describe-then-drop). Core-side: `describeAndStore` gained a
      `MediaStorePort` (default: the v1 DB — behavior unchanged; the
      consumer supplies the tg-API-backed port), and the consumer runs
      the v1 vision/voice flow from the event: in-turn recognize with
      caption/no-caption note composition, replied-to media resolution
      (no ingest-on-miss over the API — documented parity edge), eager
      voice transcription before addressing with the transcript-aware
      name check re-run core-side, one reply trace across
      transcription + reply. Env: TG_API_URL + INTERNAL_API_TOKEN on
      core. Tests: 4 tg media suites (real sharp normalization,
      unavailable markers, voice bytes, API round-trip incl.
      concurrent-winner) + 2 new consumer suites (photo recognize into
      the turn, voice answered from transcript via the re-run name
      check). Remaining for slice D: voice REPLY synthesis delivery
      (TTS bytes to tg), generated images, browser acks, `#id` links,
      feedback flows, MCP outbound tools, operator API.
      **Slice C implementation notes (worked out 2026-08-23)**:
      - `IncomingMessage` gets `message?` + `addressing?` — the consumer
        passes the event's verdict; the v1 path keeps calling
        `checkAddressed`. Only line ~524 of the service touches
        `incoming.message`.
      - The additive consumer uses v1 `getBotPolicy()` wholesale (v1
        settings still hold owner columns), so parity is exact;
        `event.sender.isOwner` becomes authoritative at the swap.
        **Swap blocker to design then (Phase 3 adjacent): task-authority
        rights** — v1 resolves "author is owner" against settings at
        match time; post-split the core must not hold owner identity, so
        tasks likely need `created_by_owner` stamped at creation.
      - Extract the `generateReply` + `applyStandingTasks` bindings from
        `process-update.ts` into a shared factory (mutable task state as
        a small state object) so the consumer and the v1 path share one
        implementation — no copy.
      - Actions-started marker: core-store `turn_actions` table
        (migration 0001), first live use of STORE_DATABASE_URL; mark
        BEFORE sendReply-publish and BEFORE each tool execution (wrap
        `callTool`); on terminal settle delete the row. Pre-action
        failure re-enqueues with attempt+1 (delay ~15s, cap 5).
      - Consumer gaps until slices B/D (documented, dev-only since the
        consumer only runs when tg feeds the queue): generated-image
        delivery, browser-run acks, linkable `#id` resolution (drops to
        plain text), vision/voice.
      - Core consumer starts from instrumentation only when REDIS_URL +
        STORE_DATABASE_URL are set.
      **Slice D landed (2026-08-23, `c0794fe` + `9aa4186` + `6b2725f`)**:
      - **D-1, outbound surface**: tg owns the transport boundary —
        `renderTelegramHtml` + `#id` link resolution against its own
        mirror (whitelist; invented ids stay text) + plain-text fallback
        — and serves the internal send API: text (silent-capable), voice
        (source-owned text fallback, reports `asVoice`), photos (mirror
        row + pending media keyed by the minted file id, real sharp
        normalization), delete (soft-deletes the mirror row), reaction
        (mirror-gated `not_found`/`own_message`, platform refusals as
        502 verbatim). Contract: reply-delivery gains `silent`, loses
        the never-consumed `preferVoice` (voice bytes cross the API,
        which can answer with the delivered id). Core consumer closes
        its slice-B/C gaps via `SourceOutboundPort`
        (`server/turn/tg-outbound.ts`, env-resolved like the media
        store): TTS synthesis stays core, audio crosses the API;
        generated images deliver after the reply; a browsing turn's
        reply goes over the API silent so its id registers as the run's
        self-deleting ack; `set_message_reaction` gets a per-turn
        `reactToMessage` port on the tool context (v1 branch unchanged,
        dies at the swap).
      - **D-2, feedback flows tg-local**: `message_reaction` +
        `callback_query` in allowed_updates; menu/options/codec ported
        verbatim; flows keep every v1 rule (menus only on the bot's own
        mirrored replies, single answerable reactor, "Other" →
        awaiting_text, free-text capture before the turn — mirrored,
        hold released, never enqueued). Completions publish the new
        `feedback.recorded` bus event (refs, reaction, text, topic;
        correlated to the reacted reply's turn). tg migration 0001:
        `feedbacks.model` nullable — this app cannot read reply traces;
        the core stamps it on write-back. No tg dev DB exists yet
        (.env.example only), so nothing local to migrate.
      - **D-3, operator API**: the shared listing/CRUD contract in
        `@assistant-hub/contracts` (`operator-api.ts`, source-neutral)
        served on `/internal`: users (labels + aliases/language PATCH),
        chats (mirror aggregates + group metadata, notes/language
        PATCH), a chat's full mirror with media annotations,
        connections CRUD (create/patch reconcile pollers via the new
        `BotManager.reconcileConnection`/`removeConnection`, delete
        stops+drops, token never returned — 4-char hint, one bot per
        assistant → 409), owner settings (changing the username resets
        the resolved id).
      - **Design call to confirm (user)**: PLAN's "source app exposes an
        MCP server for outbound actions" is implemented as the internal
        REST send API + core-side tool definitions bound per turn,
        because the tools' guardrails (delivery-kind refusals, task
        authority, actions-started marker, chat binding) are turn state
        only the core has, and the remote-MCP client machinery is
        Phase 5. The same handlers can be wrapped in an MCP endpoint on
        tg's Hono at Phase 5 if still wanted.
      - **Deferred to the swap slice**: core-side consumption of
        `feedback.recorded` (reflection scheduling, addressing-exclusion
        filing) + the folds/exchange reads and the model/reflection
        write-back endpoints on tg (`PATCH /internal/feedbacks/:id` does
        not exist yet); re-routing browser-agent runner / tasks
        scheduler / image-gen deliver onto `SourceOutboundPort` (the
        runner's ack deletion at settle still calls the v1
        `deleteChatMessage`); a `sendChatFile` equivalent endpoint for
        browser-run downloads; dashboard pages/proxy onto the operator
        API; the SSE bridge for tg-published events.
- [x] `apps/core`: telegram code removed; the pipeline consumes the
      queue; deterministic replies published as reply-delivery events;
      turn-lifecycle events published; the actions-started marker gates
      retry; core features that touch tg content (history tools,
      summarization, search indexing, vision describe) go through tg's
      API; dashboard telegram controls proxied to tg's operator API; the
      SSE layer bridges Redis pub/sub. Analytics rides the same API
      since `fe56e5f` (was the flip blocker — see Current state).
      **The swap (2026-08-23/24, commit by commit)**:
      - `7e52521` (W1): browser-agent runner, tasks scheduler and
        image-gen deliveries re-routed onto `SourceOutboundPort` (+ the
        new tg file-send endpoint with document-retry and caption
        fallback; run-ack deletion over the API); `test/simulate.ts` and
        `image-gen/deliver.ts` die.
      - `dbdc320` (W2): dashboard bot control/status/token through the
        tg operator API (`getSourceBotStatus`/`setSourceBotEnabled`/
        `saveSourceBotToken`/`saveSourceOwner`); settings owner writes
        route tg-first; `getTelegramBotToken` deleted.
      - `1a68b1a`: **the deletion** — `apps/core/server/telegram/*` and
        its tests are gone; boot is queue-consumer + events-consumer +
        schedulers only (loud warn when unconfigured); feedback learning
        re-seamed onto `feedback.recorded` (recorded-consumer →
        reflect/fold; exchange/analyze read feedbacks over the tg API;
        model/reflection write-back via `PATCH /internal/feedbacks/:id`;
        addressing exclusions file with `feedbackId: null` — the v1 FK
        cannot reference source rows).
      - `064d271`: the transitional **shadow directory** — the consumer
        mirrors event identity into v1 known_users/known_groups/
        group_members (FKs + labels keep working); curated edits
        (aliases/language/notes/owner) write tg-first, shadow second.
      - `5f4c0f5`: vision through the source — backfill, gallery and
        pending counts via `SourceMediaBrowse` (tg pending/recent media
        endpoints).
      - `3424deb`: the **content plane** — history service read-only
        over `SourceContentClient` (messages window/ids, transfer
        import, split due-scans comparing core job markers against
        source day/hour counts, summaries stored tg-side, hybrid RRF
        search + index ported to tg SQL); memory extraction re-seamed
        the same way; SQL-semantics tests moved to tg against real
        Postgres, core job tests over the contract-faithful in-memory
        `fake-source-content.ts`.
      - `5cdc242`: the SSE bridge (`dashboard.refresh` → in-process
        `publishEvent`, topics filtered against `REALTIME_TOPICS`; tg
        publishes on inbound, delivered replies, status flips, feedback
        menus).
      - `ec2b7ad`: the task-authority rework (owner stamps, above).
- [x] Trace client (`8428ea7`): apps record through the shared client
      over the bus (contracts `createSourceTraceRecorder` →
      `trace.recorded` → the core's events consumer ingests into the
      single store); correlation ids tie a turn's cross-app flow into
      one trace (tg inbound / feedback collection / delivery all stamp
      `<chatId>:<messageId>`).
- [x] Docker (`917131b`): `assistant-hub-tg` image (tsx-run Node service,
      ffmpeg, isolated drizzle migration runner on the tg chain) +
      compose service (own database via the initdb hook — first init
      only; existing deployments create it by hand) + release-matrix
      entry; core service wired with REDIS_URL / TG_API_URL /
      INTERNAL_API_TOKEN. Image build verified locally (tsx/ffmpeg/
      migrate runner resolve in-container); the full compose boot rides
      with the live end-to-end smoke (Current state).
- [ ] Tests at each seam; lint/typecheck/test/build green from the root;
      proof and risks recorded. Green as of the swap (core unit 1116 +
      integration 326/30-skipped; tg integration 43; turbo lint/
      typecheck/test/build) — stays open until the analytics re-route
      and trace client land their tests.

## Session log

- **2026-08-24 (trace client)** — The last code criterion of Phase 2
  (`8428ea7`): the shared source-trace recorder in contracts, the
  core's `trace.recorded` ingest, and tg's first instrumentation
  (inbound / feedback collection / delivery). Phase 2 now blocks only
  on the operator-run live topology smoke — and the standing
  MCP-outbound design confirmation.
- **2026-08-24 (analytics re-route)** — The flip blocker cleared
  (`fe56e5f`): analytics reads the living mirror over the tg content
  API (details under the apps/core criterion and Current state item 1).
  Proof: tg integration 52 (incl. the new 9-test analytics-SQL suite),
  core integration 326/30-skipped with the ~800-line analytics suite
  reworked onto the fake, root turbo green. Phase 2's remaining work is
  the trace client and the operator-run live smoke.
- **2026-08-23/24 (the swap)** — The Phase 2 finale executed across nine
  commits (list under the apps/core criterion): outbound features onto
  the port, dashboard controls onto the operator API, the
  `server/telegram` deletion with feedback learning re-seamed onto
  `feedback.recorded`, the transitional shadow directory, vision and
  the whole content plane (history/summaries/search/memory-extraction)
  onto tg's internal API, the SSE bridge, the task-authority rework
  (owner stamps replace id comparison; core migration 0059), and the
  `assistant-hub-tg` Docker image + compose + release matrix. Proof:
  root turbo lint/typecheck/test/build green; core unit 1116 passed,
  core integration 326 passed / 30 skipped; tg integration 43 passed;
  migration 0059 applied to the core dev DB; `docker compose config`
  valid. Risks/remaining: the analytics flip blocker, the trace
  client, and the operator-run live smoke — ordered in Current state.
  Still awaiting user confirmation: the slice-D MCP-outbound design
  call.
- **2026-08-23 (slice D)** — The last extraction slice, in three commits
  (details under the Phase 2 criteria): D-1 the outbound surface (tg
  transport boundary with HTML + mirror-checked `#id` links, the
  internal send API for text/voice/photos/delete/reaction, `silent` on
  reply-delivery replacing `preferVoice`, the core's
  `SourceOutboundPort` closing the voice/images/acks/reaction consumer
  gaps); D-2 feedback flows tg-local (reaction → menu → answer on the
  tg store, free-text capture ahead of the turn, the `feedback.recorded`
  bus event, `feedbacks.model` nullable via tg migration 0001); D-3 the
  operator API (shared listing/CRUD contract in contracts, users/chats/
  messages/connections/settings on `/internal`, connection writes
  reconciling pollers). Proof: typecheck/lint/build green from the
  root; unit suites green; integration green (tg 28 across 6 files —
  outbound API 8, feedback 6, operator 5, media 4, runtime 3, import 2;
  core turn-consumer 10 incl. the 2 new voice-delivery cases). Flagged
  for the user: the MCP-outbound design call. Deferred to the swap: the
  swap-deferral list under the slice D notes.
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
