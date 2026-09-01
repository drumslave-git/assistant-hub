# Agent Guide

This repository is **assistant-hub** (GitHub:
[drumslave-git/assistant-hub](https://github.com/drumslave-git/assistant-hub)):
a multi-user assistant platform — accounts run
their own AI assistants (personas, Telegram bots, standing tasks, tools) on
one shared brain, with a web chat and a control/observability dashboard.

It is the completed v2 redesign of a Next.js rewrite of the
[drumslave-git/ollama-tg-bot](https://github.com/drumslave-git/ollama-tg-bot)
MVP. The old MVP (available at `../ollama-tg-bot` in this workspace) is
historical reference only. Do not hardcode absolute filesystem paths in
docs, code, scripts, or tests.

## Architecture in one paragraph

Two apps in a Turborepo: **apps/core** (Next.js — dashboard, web chat, the
whole brain/pipeline, ONE Postgres database whose schema and migration
chain live in `apps/core/store/`) and **apps/tg** (a stateless Telegram
transport — it self-registers with the core at boot, forwards every update
as transport events over the Redis queue, performs sends, and hosts the
platform's MCP tools). Shared zod contracts live in `packages/contracts`;
a new transport (Signal, …) is meant to connect without core changes:
registration announces its config-field schemas, the dashboard renders
them, and platform actions are the transport's own MCP tools. Accounts
(admin/user roles) own assistants; owner rights, memory and identity
resolve through the person-link graph. `docs/PLAN.md` holds the full
design; `docs/architecture/overview.md` the operator-facing map.

## Required Reading

Before doing implementation work, read:

1. `docs/TODO.md` — the working tracker: pending features with their agreed
   specs and decisions, plus open operational items. (`docs/PROGRESS.md`
   is the completed v2 redesign's record — history, not open work.)
2. Relevant installed Next.js docs under `node_modules/next/dist/docs/`.

This is not optional. The installed Next.js version may have APIs and
conventions that differ from memory or older documentation.

## CodeGraph

This repository is indexed by CodeGraph. Use CodeGraph before grep/find/
manual file reading when you need to understand or locate code.

- Prefer `codegraph_explore` when available.
- Shell fallback: `codegraph explore "<question or symbols>"`.
- If a `.codegraph/` directory is missing in a future worktree, skip
  CodeGraph; indexing is the user's decision.

## Engineering Standards

Code must be clean, readable, and DRY.

- Features must follow shared patterns.
- Shared behavior belongs in shared modules, hooks, services, schemas,
  utilities, and components.
- Avoid case-by-case implementations for APIs, errors, traces, debug pages,
  forms, tables, status UI, pagination, filtering, timestamps, and exports.
- If similar code appears in two places, consider extracting it. By the
  third use, make it shared unless there is a documented reason not to.
- Route Handlers stay thin: validation, authorization, business logic,
  persistence, trace recording, and error mapping belong in shared server
  code. Every route declares its access level on `defineRoute` (`admin`
  default / `account` / `public`) and scopes data through the ownership
  helpers in `apps/core/server/ownership.ts`.
- Server-only logic must not leak into client bundles. Use server-only
  module boundaries for database, filesystem, Telegram, Playwright, LLM
  credentials, and secrets.
- Cross-app pointers are scoped refs (`tg:user:123`, `chat:thread:<id>`),
  never foreign keys into another app's data; the memory keyspace and every
  provenance column speak refs.
- Boot-bound singletons (queues, registries, turn state) pin themselves to
  `globalThis` — Next.js compiles several bundles per process and module
  state does not survive re-evaluation.

## Feature Contract

Every feature follows the standard feature contract, as established by
`features/settings` (the reference implementation) and documented in
`docs/development/contributing.md`: acceptance criteria; server-side
service logic; validated schemas; typed persistence (the one store chain —
edit `apps/core/store/schema.ts`, `npm run db:generate`, commit the SQL,
`npm run db:migrate`); Route Handlers on shared wrappers with the right
access level; dashboard UI that live-updates over the shared SSE layer;
registration in `lib/features.ts` with a `featureDebugHref(id)` link into
the shared `/debug` explorer (features do not get their own Debug route);
trace recording for every meaningful action with COMPLETE raw bodies;
downloadable JSON trace bundles; tests for service logic, Route Handlers,
and critical UI/debug behavior (integration suites bootstrap through
`apps/core/test/store-db.ts`).

## Standing decisions (do not reopen without the user)

- The **Mood** feature is dropped (2026-07-16); reply behavior is base
  prompt + persona only. The analytics-only mood score stays.
- The **Specialists** feature was removed completely (2026-08-19).
- No embedding/keyword **toolset routing** (2026-08-19): the full stable
  toolset is offered.
- No lexical pre-filters in front of LLM classifications; no linguistic
  heuristics in code; never rewrite model output in code — fix the prompt,
  model, or serving instead.
- The single global owner, the operator password, and the per-app
  databases are all retired (Phases 8–10); do not reintroduce them.

## Progress Tracking

Track progress in repository files, not only in chat. `docs/TODO.md` is the
working tracker; update it before and after substantial work. Statuses:
`todo`, `in-progress`, `blocked`, `done`, `deferred`. For every `done` item
record proof (files changed, tests run, check status, remaining risks); for
every `blocked` item record the blocker, the attempted approach, and the
next decision needed. Prune entries once shipped and documented under
`docs/` — git history is the archive. At handoff, leave short notes with
current state, next best task, known pitfalls, and commands that passed or
failed.

## Decision Notes

Per user preference, non-standard infrastructure or behavior decisions are
made by asking the user directly and recording the outcome in the tracker
against the entry the decision belongs to. Do not write
`docs/decisions/*.md` files.

Asking first is required for (non-exhaustive): new long-running in-process
schedulers or workers, custom servers, Socket.IO/custom WebSockets,
process-global mutable state beyond the established singletons, production
data imports, and Playwright lifecycle changes. When asking, present the
problem, the standard Next.js option considered, why it is insufficient,
alternatives, the recommended design, operational impact, and
failure/rollback behavior.

## Next.js Rules

This is not necessarily the Next.js you remember. Read the relevant guide
in `node_modules/next/dist/docs/` before writing code that depends on
Next.js APIs, file conventions, runtime behavior, caching, Route Handlers,
Server/Client Components, instrumentation, or self-hosting. Heed
deprecation notices from the installed docs and build output.

## Verification

Before marking work done, run the narrowest meaningful checks first, then
the broader checks when the change is large enough:

- `npm run lint`
- `npm run typecheck`
- `npm run test` (unit; no Docker needed)
- `npm run test:integration -w @assistant-hub/core` (Testcontainers;
  Docker required)
- `npm run build`

If a check cannot be run, record why in `docs/TODO.md`.
