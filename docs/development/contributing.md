# Contributing

Read this alongside `AGENTS.md` (the short, authoritative version), and check
`NEXTJS_REWRITE_PLAN.md` for scope plus `NEXTJS_REWRITE_PROGRESS.md` for current
status and Decision Notes before starting implementation work.

## Non-negotiables

| Rule | Why |
| --- | --- |
| This is a **rewrite**, not a migration | The old MVP (`../ollama-tg-bot`) is a behavior/reference source only. Reuse its code only where the shape is still the best one |
| **Ask before non-standard infrastructure** | Custom servers, extra worker services, process-global mutable state, browser lifecycles beyond per-job, MVP data import — present the problem, the standard Next.js option, why it is insufficient, the alternatives, and your recommendation. Record the outcome in the Decision Notes table |
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
- **Server-only logic must not leak into client bundles.** Modules touching the
  database, filesystem, Telegram, Playwright, LLM credentials or secrets import
  `server-only`.

## Layer discipline

| Layer | Holds | Must not hold |
| --- | --- | --- |
| `app/api/**/route.ts` | Schema declaration + one service call | Logic, SQL, tracing |
| `features/*/server/service.ts` | Policy, validation, tracing, orchestration | SQL |
| `features/*/server/repository.ts` | Typed Drizzle access, taking a `DrizzleDb` | Policy, validation, tracing |
| `features/*/server/schema.ts` | The zod contract shared by service, routes and UI | — |
| `features/*/{types,format,<pure>}.ts` | Client-safe types and pure logic | Any `server-only` import |
| `lib/` | Pure contracts both client and server need | DB, secrets, `server-only` |
| `server/` | Shared infrastructure | Feature-specific policy |

A repository takes a `DrizzleDb` argument (defaulting to `getDb()`) so the same code
runs against the production pool and a Testcontainers instance.

## The feature contract

A feature is not done until it has:

1. Explicit acceptance criteria.
2. Server-side service logic.
3. Validated input/output schemas.
4. Typed persistence where needed.
5. Route Handlers using the shared `defineRoute` wrapper.
6. A normal dashboard page where applicable.
7. Debug visibility — see below.
8. Trace recording for every meaningful action.
9. A downloadable JSON log/trace bundle.
10. Tests for service logic, Route Handlers, and critical UI/Debug behavior.

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

1. **Register it** in `lib/features.ts` — `id`, `label`, and where applicable
   `realtimeTopic`, `relatedIdsKey`, `path`. The id is the trace `feature` string and
   the Debug filter value; referencing the registry from both writer and reader turns a
   mismatch into a compile error.
2. **Schema** (`server/schema.ts`) — zod, pure (no `server-only`) so tests can build
   inputs against the same schema the handlers parse. Keep bounds here.
3. **Types** (`types.ts`) — client-safe, no server-only runtime import.
4. **Repository** — typed Drizzle access, `DrizzleDb` parameter, no policy.
5. **Migration** — edit `db/schema.ts`, then run **both**:
   ```bash
   npm run db:generate && npm run db:migrate
   ```
   Generating without applying leaves your dev database on the old schema. Commit the
   generated SQL.
6. **Service** — the boundary. Wrap mutations in `withTrace`, throw `ApiError` for
   expected failures, publish a realtime event on state change.
7. **Route Handlers** — `defineRoute`, `parseJson`/`parseQuery`, `ok(...)`. One service
   call per handler.
8. **UI** — a Server Component page reading the service directly (no internal fetch),
   with interactivity pushed to leaf Client Components. Subscribe to live updates.
9. **Background work**, if any — see
   [Background jobs](../architecture/background-jobs.md#adding-a-job).
10. **MCP tools**, if any — see
    [LLM and MCP](../architecture/llm-and-mcp.md#adding-a-tool).
11. **Tests** — unit for every pure decision, integration for persistence, and a
    tool-selection test if you added a tool.
12. **Docs** — a page under `docs/features/`, and a row in
    `docs/features/README.md`.
13. **Progress** — update `NEXTJS_REWRITE_PROGRESS.md` with files changed, checks run,
    and remaining risks.

## UI conventions that are not optional

These come from repeated correction; violating one is a review comment every time.

| Rule | Detail |
| --- | --- |
| **Every rendered time goes through `<Timestamp>`** | Never `toLocaleString()`, never bare UTC, and never a timezone prop — the zone comes from `TimezoneProvider` |
| **Every data page live-updates** | `publishEvent` on the server, `useLiveRefresh`/`useLiveEvent` + `LiveIndicator` on the client. A page that needs a manual reload is a bug |
| **Multiple sections on one page go into the shared `Tabs`**, not stacked cards | Job cards stay above the tabs. Drop card titles that duplicate a tab label |
| **Import primitives from `@/components/ui`** | One stable entry point for the design system |
| **Background failures must reach the UI** | A `console.error`-only failure is invisible to the operator. Surface it on a status card or, for the data-destroying class, `SystemAlerts` |
| **Status must probe the real thing** | Never report "configured" from the presence of a value. Connect to the database, call the endpoint |

## Trace conventions

| Rule | Detail |
| --- | --- |
| Event `message` is a **clean human title** | "system prompt composed", not `llm_request`. The stage badge comes from `type` |
| Bodies are **complete and raw** | The whole system prompt, the whole message list, the whole tool result. Never trimmed or hand-picked |
| The only exception is binary blobs | Image and audio bytes become a `data:<mime>;base64,<N bytes>` marker; the real media is in `message_media` |
| Add event *types* to `lib/trace.ts` | Do not invent a per-feature trace shape |
| Trace what the operator must be able to explain | Including decisions to stay silent. Skip high-volume passive capture |

## LLM conventions

| Rule | Detail |
| --- | --- |
| **Never gate an LLM classification on a heuristic guess** | Detection quality beats saved calls. A lexical pre-filter was built and reverted |
| **No linguistic heuristics in code** | No transliteration tables, romanization folds or phonetic name matching. Language judgment belongs to the model; code checks mechanical facts |
| **Require citations for verdicts** | Small local models bluff enum classifications. Demand verbatim evidence and verify in code that the quote is real |
| **Classify errors by concept, not phrasing** | One server words the same failure differently per route. Pin live phrasings in tests |
| **Tool boundaries resolve, never throw** | Hand the model a usable failure message so the reply carries on |
| **Tools self-describe and name no other tool** | The system prompt lists no tools at all |
| **Fail closed** | An unusable response leaves stored state untouched and the unit owed. An empty merge is a *failed* pass, never "this is now empty" |
| **Record the call kind** | Add to `features/analytics/llm-call-kind.ts` so Model performance can separate it |

## Verification

Run the narrowest meaningful check first, then broaden:

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

`npm run test:integration` needs Docker; run it when you touched persistence. If a
check cannot be run, record why in `NEXTJS_REWRITE_PROGRESS.md`.

Two local-development cautions:

- **Never `rm -rf .next` or run a production build while `next dev` is live** — it
  kills the running server.
- **Never commit on the user's behalf.** The user does their own commits.

## Progress tracking

Update `NEXTJS_REWRITE_PROGRESS.md` before and after substantial work, using the
statuses `todo`, `in-progress`, `blocked`, `done`, `deferred`.

| For a | Record |
| --- | --- |
| `done` item | Files changed, tests run, build/typecheck/lint status, remaining risks |
| `blocked` item | The blocker, what was attempted, the next decision needed |
| Handoff | "Next Agent Notes": current state, next best task, known pitfalls, commands that passed or failed |

Decisions go in the Decision Notes **table** in that file. Do not write
`docs/decisions/*.md` files.

## Feature priority

The authoritative order lives in `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md`. Features not listed there are not v1 by default — add
one to the tracker with explicit priority, acceptance criteria and dependencies before
implementing it.

The **Mood** feature (the bot's own mood injected into replies) is deprecated and
dropped (user decision, 2026-07-16). Do not implement it and do not re-add it to the
priority list without a new decision. This does not touch the analytics-only mood
score.

## CodeGraph

This repository is indexed by CodeGraph. Prefer it over grep/find/manual file reading
when locating or understanding code:

```bash
codegraph explore "how does the addressing analyzer decide"
```

```bash
codegraph node features/bot-messaging/server/service.ts
```

If a future worktree has no `.codegraph/` directory, skip it — indexing is the user's
decision.
