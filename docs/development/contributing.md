# Contributing

Read this alongside `AGENTS.md` (the short, authoritative version), and check
[`docs/TODO.md`](../TODO.md) — pending features with their agreed specs and
decisions, plus open items — before starting implementation work.

Paths are relative to `apps/core/` unless they start with `apps/` or `packages/`.

## Non-negotiables

| Rule | Why |
| --- | --- |
| The old MVP (`../ollama-tg-bot`) is a **reference**, not a source | Its behavior is the baseline where a doc says "MVP parity"; reuse its code only where the shape is still the best one |
| **Ask before non-standard infrastructure** | Custom servers, extra worker services, process-global mutable state beyond the established singletons, browser lifecycles beyond per-job, production data imports — present the problem, the standard Next.js option, why it is insufficient, the alternatives, and your recommendation. Record the outcome in `docs/TODO.md` against the entry it belongs to |
| **Read the installed Next.js docs** (`node_modules/next/dist/docs/`) before writing code that depends on Next APIs | The installed version may differ from memory. Heed deprecation notices from the docs and the build output |
| **No hardcoded absolute filesystem paths** in code, docs, scripts or tests | — |
| **No real personal data** in code, tests, seeds or docs | Use synthetic placeholders |
| **Never invent a field or a placeholder value** to fill a gap | Consult the MVP for the real behavior, or ask |

## Engineering standards

Clean, readable, DRY. Concretely:

- **Features follow shared patterns.** If you are writing bespoke plumbing for
  errors, traces, forms, tables, pagination, filtering, timestamps, status UI or
  exports, stop — that plumbing exists.
- **Extract before the second bespoke copy.** If a second consumer of a pattern is
  imminent, build the shared component *first* and use it. Do not ship a second
  hand-rolled copy with a "refactor later" note. By the third use, sharing is
  mandatory unless there is a documented reason not to.
- **Route Handlers stay thin.** Validation, authorization, business logic,
  persistence, trace recording and error mapping belong in shared server code.
  Every route declares its access level on `defineRoute` (`admin` default /
  `account` / `public`) and scopes data through `server/ownership.ts`.
- **Server-only logic must not leak into client bundles.** Modules touching the
  database, filesystem, Playwright, LLM credentials or secrets import
  `server-only`.
- **Apps never import each other.** The core and a transport share code only
  through `packages/*` — and a transport, living in its own repository, only
  through the published `packages/transport-sdk`; a cross-app pointer is a
  scoped ref (`tg:user:123`), never a foreign key. Anything that touches a
  platform's API belongs in that platform's transport; the core stays
  platform-agnostic. A change to what crosses the boundary is a change to
  `packages/contracts`, to the SDK's version, and to both sides — and, when
  it is incompatible, to `CONTRACT_MAJOR`.

## Layer discipline

| Layer | Holds | Must not hold |
| --- | --- | --- |
| `app/api/**/route.ts` | Schema declaration + access level + one service call | Logic, SQL, tracing |
| `features/*/server/service.ts` | Policy, validation, tracing, orchestration | SQL |
| `features/*/server/repository.ts` | Typed Drizzle access, taking a `StoreDb` | Policy, validation, tracing |
| `features/*/server/schema.ts` | The zod contract shared by service, routes and UI | — |
| `features/*/{types,format,<pure>}.ts` | Client-safe types and pure logic | Any `server-only` import |
| `lib/` | Pure contracts both client and server need | DB, secrets, `server-only` |
| `server/` | Shared infrastructure: auth, ownership, HTTP, the queue consumers, the bus, LLM, MCP, jobs, trace, realtime, the conversation store | Feature-specific policy |
| `packages/contracts` | What crosses between apps: zod schemas and pure helpers | Anything app-specific, any runtime dependency beyond zod |
| a transport (its own repository) | Everything about one platform: the wire format, the platform API, the platform's tools | Any decision about replying, any storage |

A repository takes a `StoreDb` argument (defaulting to `getStoreDb()`) so the
same code runs against the production pool and a Testcontainers instance.

## The feature contract

A feature is not done until it has:

1. Explicit acceptance criteria.
2. Server-side service logic.
3. Validated input/output schemas.
4. Typed persistence where needed.
5. Route Handlers using the shared `defineRoute` wrapper with the right access
   level.
6. A normal dashboard page where applicable, live-updating over the shared SSE
   layer.
7. Debug visibility — see below.
8. Trace recording for every meaningful action, with complete raw bodies.
9. A downloadable JSON log/trace bundle.
10. Tests for service logic, Route Handlers, and critical UI/Debug behavior.

`features/settings` is the reference implementation.

### Debug visibility

**`/debug?feature=<id>` is the contract.** A feature does not get its own Debug route:
`/debug` is the single explorer for every feature, and a feature links into it
pre-filtered with `featureDebugHref(id)` from `lib/features.ts`. One filter list, one
detail view, one bundle export — and because the filter lists every *registered*
feature rather than only those with traces, a new feature is selectable the moment it
is registered.

Build a bespoke debug UI only for a genuinely unique visualization need — and if you
do, compose `components/debug/` rather than restyling it.

An operator must be able to inspect, from the trace alone: when it happened, what
triggered it, the input, each decision step, external calls, LLM request/response
metadata and token usage, generated outputs, errors, and related row ids.

## Adding a feature: the checklist

1. **Register it** in `lib/features.ts` — `id`, `label`, `group`, and where
   applicable `realtimeTopic`, `relatedIdsKey`, `path`. The id is the trace
   `feature` string and the Debug filter value; referencing the registry from
   both writer and reader turns a mismatch into a compile error.
2. **Schema** (`server/schema.ts`) — zod, pure (no `server-only`) so tests can build
   inputs against the same schema the handlers parse. Keep bounds here.
3. **Types** (`types.ts`) — client-safe, no server-only runtime import.
4. **Repository** — typed Drizzle access, `StoreDb` parameter, no policy.
5. **Migration** — edit `store/schema.ts`, then run **both**:
   ```bash
   npm run db:generate && npm run db:migrate
   ```
   Generating without applying leaves your dev database on the old schema. Commit the
   generated SQL under `store/migrations/`.
6. **Service** — the boundary. Wrap mutations in `withTrace`, throw `ApiError` for
   expected failures, publish a realtime event on state change.
7. **Route Handlers** — `defineRoute` with `access`, `parseJson`/`parseQuery`,
   `ok(...)`. One service call per handler. Account-level routes gate every row
   through `server/ownership.ts`.
8. **UI** — a Server Component page reading the service directly (no internal fetch),
   with interactivity pushed to leaf Client Components. Subscribe to live updates.
   Pages a user-role account may see live outside `app/(dashboard)/(admin)/` and
   are listed with `adminOnly: false` in `components/layout/nav-config.ts`.
9. **Background work**, if any — see
   [Background jobs](../architecture/background-jobs.md#adding-a-job).
10. **MCP tools**, if any — see
    [LLM and MCP](../architecture/llm-and-mcp.md#adding-a-tool). A tool that acts
    on a platform belongs in that transport's own MCP server.
11. **Transport-facing behavior**, if any — a new event, a new internal call —
    goes through `packages/contracts` and both apps; see
    [Adding a transport](adding-a-transport.md).
12. **Tests** — unit for every pure decision, integration for persistence, and a
    tool-selection test if you added a tool.
13. **Docs** — a page under `docs/features/`, and a row in
    `docs/features/README.md`.
14. **Progress** — update `docs/TODO.md` with files changed, checks run, and
    remaining risks; prune the entry once the work is shipped and documented.

## UI conventions that are not optional

These come from repeated correction; violating one is a review comment every time.

| Rule | Detail |
| --- | --- |
| **Every rendered time goes through `<Timestamp>`** | Never `toLocaleString()`, never bare UTC, and never a timezone prop — the zone comes from `TimezoneProvider` |
| **Every data page live-updates** | `publishEvent` on the server, `useLiveRefresh`/`useLiveEvent` + `LiveIndicator` on the client. A page that needs a manual reload is a bug. A transport pings the same topics through a `dashboard.refresh` bus event |
| **Multiple sections on one page go into the shared `Tabs`**, not stacked cards | Job cards stay above the tabs. Drop card titles that duplicate a tab label |
| **Import primitives from `@/components/ui`** | One stable entry point for the core's design system; `packages/ui` holds the pieces shared with other apps |
| **Every query filter has a visible control** | Ids on cards are clickable facets, never free text the reader has to type |
| **Background failures must reach the UI** | A `console.error`-only failure is invisible to the operator. Surface it on a status card or, for the data-destroying class, `SystemAlerts` |
| **Status must probe the real thing** | Never report "configured" from the presence of a value. Connect to the database, call the endpoint, read the transport's health |

## Trace conventions

| Rule | Detail |
| --- | --- |
| Event `message` is a **clean human title** | "system prompt composed", not `llm_request`. The stage badge comes from `type` |
| Bodies are **complete and raw** | The whole system prompt, the whole message list, the whole tool result. Never trimmed or hand-picked |
| The only exception is binary blobs | Image and audio bytes become a `data:<mime>;base64,<N bytes>` marker; the real media is in `source_media` |
| Add event *types* to `lib/trace.ts` (and the mirror in `packages/contracts/src/trace.ts`) | Do not invent a per-feature trace shape. A transport records through the contract's recorder and the core persists it |
| **Never hand-record LLM exchanges** | Pass `trace: { recorder, callKind, label? }` to `chatCompletion` / `chatCompletionWithTools`; the shared layer records request (endpoint + full body), rounds, tool calls and retries identically for every feature |
| A multi-trace flow shares one `correlationId` | A turn is `<chatRef>:<sourceMessageId>:<assistantId>` (`turnCorrelationId`) — the ingest's `inbound`, the pipeline's `reply`, the transport's `deliver` and every tool-call trace carry it; a sweep stamps `newRunCorrelationId(job)` on every trace of the run. A standalone trace self-correlates automatically |
| Trace what the operator must be able to explain | Including decisions to stay silent. Skip high-volume passive capture |

## LLM conventions

| Rule | Detail |
| --- | --- |
| **Never gate an LLM classification on a heuristic guess** | Detection quality beats saved calls. A lexical pre-filter was built and reverted |
| **No linguistic heuristics in code** | No transliteration tables, romanization folds or phonetic name matching. Language judgment belongs to the model; code checks mechanical facts |
| **Never rewrite model output in code** | Fix the prompt, the model or the serving instead |
| **Require citations for verdicts** | Small local models bluff enum classifications. Demand verbatim evidence and verify in code that the quote is real |
| **Classify errors by concept, not phrasing** | One server words the same failure differently per route. Pin live phrasings in tests |
| **Tool boundaries resolve, never throw** | Hand the model a usable failure message so the reply carries on |
| **Tools self-describe and name no other tool** | The system prompt lists no tools at all. The full stable toolset is offered — no routing (user decision, 2026-08-19) |
| **Fail closed** | An unusable response leaves stored state untouched and the unit owed. An empty merge is a *failed* pass, never "this is now empty" |
| **Record the call kind** | Add to `features/analytics/llm-call-kind.ts` so Model performance can separate it |

## Verification

Run the narrowest meaningful check first, then broaden (root scripts fan out
across the workspaces through turbo):

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run test
```

```bash
npm run build
```

`npm run test:integration` needs Docker; run it when you touched persistence,
the ingest, the turn consumer or the bus. `npm run test:linux` runs the whole
suite inside a Linux container when the Windows lockfile gets in the way. If a
check cannot be run, record why in `docs/TODO.md`.

Local-development cautions:

- **Never `rm -rf .next` or run a production build while `next dev` is live** — it
  kills the running server.
- **Boot-time code needs a restart.** The queue consumers, the schedulers and
  everything a transport does at boot (registration, the reconcile, the bus
  subscriptions) are started once; `next dev` and `tsx watch` do not re-run
  them the way a page re-renders. Restart before judging a live check.
- **Commits go straight to `main`** — this project has no feature branches.
  Never push on the user's behalf.

## Progress tracking

Update `docs/TODO.md` before and after substantial work, using the statuses
`todo`, `in-progress`, `blocked`, `done`, `deferred`. Prune entries once the
work is shipped and documented under `docs/` — git history is the archive; the
tracker holds only open work.

| For a | Record |
| --- | --- |
| `done` item | Files changed, tests run, build/typecheck/lint status, remaining risks |
| `blocked` item | The blocker, what was attempted, the next decision needed |
| Handoff | Short handoff notes: current state, next best task, known pitfalls, commands that passed or failed |

Decisions are recorded in `docs/TODO.md`, against the entry they belong to. Do
not write `docs/decisions/*.md` files.

## Scope

Pending work and its priority live in `docs/TODO.md`. Features not listed are
not in scope by default — add one to `docs/TODO.md` with explicit priority,
acceptance criteria and dependencies before implementing it.

Standing decisions not to reopen without the user: the **Mood** feature is
dropped (2026-07-16; the analytics-only mood score stays); **Specialists** were
removed completely (2026-08-19); there is no embedding or keyword **toolset
routing** (2026-08-19); the single global owner, the operator password and the
per-app databases are retired (Phases 8–10).

## CodeGraph

This repository is indexed by CodeGraph. Prefer it over grep/find/manual file reading
when locating or understanding code:

```bash
codegraph explore "how does the addressing analyzer decide"
```

```bash
codegraph node apps/core/features/bot-messaging/server/service.ts
```

If a future worktree has no `.codegraph/` directory, skip it — indexing is the user's
decision.
