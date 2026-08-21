# v2 Redesign Progress

Working tracker for the redesign described in [PLAN.md](PLAN.md). Statuses:
`todo`, `in-progress`, `blocked`, `done`, `deferred` — same rules as
[TODO.md](TODO.md) (proof for `done`, blocker + next decision for `blocked`).
Per user decision (2026-08-21), redesign progress lives here, not in TODO.md.

## Current state

Phase 0 (scaffold) is done on the long-lived `redesign` branch (created
2026-08-21 from main at the tracing-unification commit).

Next best task: Phase 1 — per-app databases and schema modules, scoped-ref
and person-link foundations, migration scripts + verification harness.
Remember the open Phase 2 decision from planning: queue retry semantics.

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
| 1 | Per-app databases + schemas, scoped refs, person links, migration scripts + rehearsal | todo |
| 2 | Source split: telegram runtime out of core into apps/tg, source contract, Redis bus + queue | todo |
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
