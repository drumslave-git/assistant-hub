# Testing

Three tiers, three different costs, three different purposes.

| Tier | Command | Needs | Count |
| --- | --- | --- | --- |
| **Unit** | `npm run test` | Nothing | ~72 files |
| **Integration** | `npm run test:integration` | Docker (Testcontainers) | ~32 files |
| **Live** (a subset of integration) | `npm run test:integration` with a configured LLM | Docker + a reachable LLM endpoint | Marked `*-live` / tool-selection |

Tests are **colocated** with the code they cover: `addressing.test.ts` sits beside
`addressing.ts`. The default suite excludes `*.integration.test.ts`.

## Unit tests

`vitest.config.ts`, `environment: "node"`. Two aliases make server code directly
testable:

| Alias | Points at | Why |
| --- | --- | --- |
| `server-only` | `test/stubs/empty.ts` | The real package throws outside an RSC bundle |
| `@` | The repo root | Mirrors the tsconfig path alias |

What belongs here: every pure decision. The codebase is deliberately structured so
that the interesting logic *is* pure and does not need a database or a model:

| Module | What its test pins |
| --- | --- |
| `features/bot-messaging/addressing.ts` | Every deterministic addressing rule, and the undecided cases |
| `features/bot-messaging/server/address-analyzer.ts` | Prompt building, enum parsing, citation verification |
| `features/bot-messaging/server/policy.ts` | Owner and maintenance decisions |
| `features/bot-messaging/telegram-html.ts` | That the output cannot contain an unbalanced tag |
| `features/analytics/period.ts` | The bucket math — including that the JS keys match Postgres's `to_char(date_trunc(...))` |
| `features/tasks/schedule.ts` | Wall-clock ↔ UTC conversion across timezones |
| `features/history/csv.ts` | The one CSV dialect, both directions |
| `server/jobs/daily-due.ts` | Due math: idempotent across restarts, immune to drift |
| `server/mcp/openai-tools.ts` | MCP ↔ OpenAI shape conversion |
| `lib/api-error.ts`, `lib/format.ts`, `lib/language.ts` | The shared contracts |

Services are testable here too, because their collaborators are **injected**:
`features/bot-messaging/server/service.test.ts` drives the whole reply policy with no
LLM and no Telegram. `test/__mocks__/` holds the standard fakes (`policy`,
`telegram`, `users`, `vision`).

## Integration tests

`vitest.integration.config.ts`. Real Postgres, per-file, via Testcontainers.

| Setting | Value | Why |
| --- | --- | --- |
| `testTimeout` | 60s | Container startup |
| `hookTimeout` | 180s | Image pull on a cold machine |
| `fileParallelism` | `false` | Files run serially to bound resource use |
| `setupFiles` | `test/setup-trace-store.ts` | Isolates the file-backed trace store |

### `test/db.ts`

```ts
const { db, truncate, stop } = await startTestDb();
```

Starts a `pgvector/pgvector:pg17` container, builds a Drizzle handle, and **runs the
real migrations** from `db/migrations/`. That last part is load-bearing: it means the
integration suite fails if a migration is broken, and it means a schema change you
generated but did not apply still passes here — which is exactly the trap that hides an
unapplied migration until the operator's bot crashes on the old schema. Always run
`npm run db:migrate` against your dev database too.

`truncate()` clears every table discovered from the schema module, so tests do not have
to enumerate them.

### `test/setup-trace-store.ts`

Points the trace directory at a fresh temp path (`__setDataDirsForTests`) and resets the trace-store singleton
before every test. Traces live in files rather than the database, so truncating tables
would not isolate them.

### What integration tests cover

Persistence and the flows that only make sense end to end:

| File | Covers |
| --- | --- |
| `server/telegram/process-update.integration.test.ts` | The real pipeline, message in → reply out |
| `server/telegram/process-update.concurrency.integration.test.ts` | Concurrent updates across chats, ordered within a chat |
| `server/telegram/live-flow.integration.test.ts` | The whole flow against a live model |
| `features/*/server/*.integration.test.ts` | Each feature's persistence, plus its job's idempotency |
| `server/jobs/lock.integration.test.ts` | Advisory locks actually exclude |
| `server/auth/auth.integration.test.ts` | Setup/login/session against the real row |
| `server/status.integration.test.ts` | The health and status probes |

## The simulation harness

`test/simulate.ts` is the reason the transport seam exists.

```ts
const result = await simulateUpdate({
  text: "remind me in 5 minutes",
  chatType: "group",
  from: { id: 100, username: "tester" },
});
```

It builds a minimal but well-formed Telegram `Message` from a compact input, runs it
through the **real** `processUpdate` pipeline, and captures the sink:

| Field | Contents |
| --- | --- |
| `outcome` | The `HandleOutcome` (`ignored` + reason, `replied` + text, or `error`) |
| `replies` | Every text reply delivered, in order |
| `photos` | Every photo delivered (generated images) |
| `voices` | Every voice bubble delivered (TTS replies) |
| `typingCalls` | How many times the typing action was requested |

No bot, no token, no Telegram API. Collaborators can be overridden per call, so a test
can stub vision or the LLM while leaving the rest of the pipeline real.

Use it to test *behavior*, not plumbing: "does the bot answer a group message that
mentions it", "does a maintenance-mode block send the notice and not call the LLM",
"does a voice message get transcribed before addressing is decided".

## Tool-selection tests

`test/tool-selection.ts` answers a question nothing else can: **does a real model
actually pick the right tool for the phrasings people use?**

```ts
const run = await runToolSelection({ prompt: "what did we decide about the invoice?" });
expectToolCalled(run, "history_recall_topics");
expectToolNotCalled(run, "browse_web");
```

It loads the app's real environment (`@next/env`), resolves the configured LLM runtime
and the **real toolset** from the MCP registry, builds the real system prompt and time
context, and runs the actual tool loop — with **canned tool results** so no real search,
page read or database lookup happens. Each canned result is shaped like the real one,
including message ids on a recalled topic so a "recall then read the originals"
two-step has ids to follow.

These tests are the regression net for tool **descriptions**. A description is
production behavior: when it changes, which tool the model picks changes. `browse_web`
must be chosen when a user asks to download something, or to look anything up — and
must **not** fire on casual chat or a fact the model already knows. `expectToolNotCalled` matters as much as
`expectToolCalled`.

They need a reachable LLM and a configured model, and they cost tokens. In this
project's dev setup the LLM is local and self-hosted, so **token spend is not a reason
to skip them** — run the jobs.

## Running a subset

```bash
npx vitest run features/bot-messaging
```

```bash
npx vitest run --config vitest.integration.config.ts features/memory
```

```bash
npm run test:watch
```

## CI

`.github/workflows/release.yml`'s `verify` job runs `npm run lint`,
`npm run typecheck` and `npm run test` — unit tests only. The integration suite needs
Docker and is not part of the release gate, so **run it locally** when you touch
persistence, migrations, or a job's idempotency.

CI uses `npm install` rather than `npm ci` for the same lockfile reason as the
Dockerfile: the lockfile is generated on Windows and omits Linux-only optional native
dependencies.

## What to write for a new feature

| Change | Test |
| --- | --- |
| A pure decision (addressing, schedule math, formatting, parsing) | Unit test, colocated. Non-negotiable |
| A repository or a migration | Integration test against a real database |
| A background job | Integration test proving idempotency: run it twice, assert the second run is a no-op |
| An LLM-derived job | Unit-test the prompt builder and the parser separately. The parser is the fail-closed boundary — test the garbage cases |
| A new MCP tool | A tool-selection test for the phrasings it should and should **not** win |
| A Route Handler | Its behavior is mostly the shared wrapper's; test the service instead, plus schema tests for the contract |
| A live-provider phrasing you had to handle | Pin the phrasing in a test, so a provider upgrade that changes it fails loudly |

## Things that are hard to test, and how they are handled instead

| Concern | Approach |
| --- | --- |
| Real browser behavior | Live integration tests marked `*-live`, plus pure tests for the snapshot script builder and HLS parsing |
| Telegram API | The transport seam — the whole pipeline runs with a capturing sink |
| Model quality | Not asserted. What *is* asserted: tool selection, that verdicts require real citations, and that parsers fail closed |
| Timing/scheduling | The due math is pure and directly unit-tested; the ticker itself is thin |
