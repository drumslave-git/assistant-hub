# Testing

Three tiers, three different costs, three different purposes.

| Tier | Command | Needs | Count |
| --- | --- | --- | --- |
| **Unit** | `npm run test` | Nothing | 115 files (108 in `apps/core`, 3 in `apps/tg`, 3 in `packages/contracts`, 1 in `packages/service`) |
| **Integration** | `npm run test:integration` | Docker (Testcontainers) | 41 `*.integration.test.ts` files (40 in `apps/core`, 1 in `packages/bus`) |
| **Live** (a subset of integration) | `npm run test:integration` with a configured LLM | Docker + a reachable LLM endpoint | Marked `*-live` / tool-selection |

Tests are **colocated** with the code they cover: `addressing.test.ts` sits beside
`addressing.ts`. The default suite excludes `*.integration.test.ts`.

## Root scripts vs. per-workspace commands

The root scripts are turbo fan-outs: `npm run test` runs `vitest run` in every
workspace that has a `test` script (`apps/core`, `apps/tg`, `packages/contracts`,
`packages/service`), and `npm run test:integration` runs `test:integration` where it
exists (`apps/core` and `packages/bus`). `npm run test:watch` is core-only.

To run one workspace, or one file, go there and call vitest directly:

```bash
cd apps/core && npx vitest run features/bot-messaging
cd apps/core && npx vitest run --config vitest.integration.config.ts server/turn
cd apps/tg && npx vitest run
cd packages/bus && npx vitest run --config vitest.integration.config.ts
```

Every vitest config excludes `**/.claude/worktrees/**`: an agent worktree is a full
checkout *inside* the repo, so without that every test file would run twice — and the
worktree's copy against a different revision.

## Running the unit suite on a Windows host

```bash
npm run test:linux
```

`docker compose -f docker-compose.test.yml run --rm test` — the same suite inside
`node:24-alpine`, and the way to prove the whole thing from a Windows machine.

Two suites — `features/browser-agent/server/ytdlp-binary.test.ts` and
`media-download.test.ts` — spawn a **real** stub binary, because what they prove is
that the app executes the right file: which copy of yt-dlp a download runs, and that a
downloaded one is executed before it is allowed to replace a working install. A
portable stub for that is a shebang script, which Windows cannot spawn
(`CreateProcess` runs PE binaries, and Node refuses `.bat`/`.cmd` without a shell).
They are also describing a platform Windows is not: upstream publishes no single-file
yt-dlp for it, so the updater is a documented no-op there.

So those two skip themselves off POSIX through `test/platform.ts`
(`describeOnPosix`) rather than being rewritten around a mocked `spawn`, which
would drop the one guarantee they exist for — and `npm run test:linux` runs them.
A Windows `npm run test` reports them as skipped, not passed.

The repository is bind-mounted into that container, but `node_modules` (root and
`apps/core`) are named volumes: esbuild, rollup and lightningcss ship per-platform
native builds, so the host's install cannot execute there. The first run populates
the volumes (a couple of minutes); later runs start in seconds. Arguments pass
through, so a subset works too:

```bash
npm run test:linux -- npx vitest run features/browser-agent
```

## Unit tests

`apps/core/vitest.config.ts`, `environment: "node"`. Two aliases make server code
directly testable:

| Alias | Points at | Why |
| --- | --- | --- |
| `server-only` | `test/stubs/empty.ts` | The real package throws outside an RSC bundle |
| `@` | `apps/core/` (the app root) | Mirrors the tsconfig path alias |

What belongs here: every pure decision. The codebase is deliberately structured so
that the interesting logic *is* pure and does not need a database or a model:

| Module | What its test pins |
| --- | --- |
| `features/bot-messaging/server/addressing.ts` | Every deterministic addressing rule, and the undecided cases |
| `features/bot-messaging/server/address-analyzer.ts` | Prompt building, enum parsing, citation verification |
| `features/bot-messaging/server/policy.ts` | The maintenance decision |
| `apps/tg/src/telegram-html.ts` | That the output cannot contain an unbalanced tag (the renderer moved to the transport with the sends) |
| `apps/tg/src/addressing.ts`, `apps/tg/src/inbound.ts` | The structural verdict the transport stamps on each receiver, and the one-forward-per-group-message rule |
| `server/turn/render.ts`, `server/turn/loop-guard.ts` | The transcript the model sees, and when assistants sharing a chat go quiet |
| `features/analytics/period.ts` | The bucket math — including that the JS keys match Postgres's `to_char(date_trunc(...))` |
| `features/tasks/schedule.ts` | Wall-clock ↔ UTC conversion across timezones |
| `features/history/csv.ts` | The one CSV dialect, both directions |
| `server/jobs/idle-scheduler.ts`, `server/jobs/interval-scheduler.ts` | The two scheduler shapes every background job is built on |
| `server/mcp/openai-tools.ts`, `server/mcp/schema-compat.ts` | MCP ↔ OpenAI shape conversion, and the schema forms strict providers reject |
| `server/llm/*` | Backend detection, error classification by concept, the tool loop |
| `lib/api-error.ts`, `lib/format.ts`, `lib/language.ts`, `lib/features.ts` | The shared contracts |
| `packages/contracts/src/*` | Scoped refs and the event schemas both apps parse |

Services are testable here too, because their collaborators are **injected**:
`features/bot-messaging/server/service.test.ts` drives the whole reply policy with no
LLM and no Telegram. `test/__mocks__/` holds the standard fakes (`policy`,
`telegram`, `users`, `vision`); `test/fake-mcp-server.ts` and
`test/fake-source-content.ts` stand in for a remote MCP server and a source's content
API.

## Integration tests

`apps/core/vitest.integration.config.ts`. Real Postgres, per-file, via Testcontainers.

| Setting | Value | Why |
| --- | --- | --- |
| `testTimeout` | 60s | Container startup |
| `hookTimeout` | 180s | Image pull on a cold machine |
| `fileParallelism` | `false` | Files run serially to bound resource use |
| `setupFiles` | `test/setup-trace-store.ts` | Isolates the file-backed trace store |

### `test/store-db.ts`

```ts
const { db, pool, connectionUri, truncate, stop } = await startTestStoreDb();
```

Starts a `pgvector/pgvector:pg17` container (through `@assistant-hub-swarm/db/testing`'s
`startTestPostgres` — one container, any number of databases inside it), creates a
database, builds a Drizzle handle, and **runs the real migrations** from
`apps/core/store/migrations`. That last part is load-bearing: it means the integration
suite fails if a migration is broken, and it means a schema change you generated but
did not apply still passes here — which is exactly the trap that hides an unapplied
migration until the operator's bot crashes on the old schema. Always run
`npm run db:migrate` against your dev database too.

`truncate()` clears every table discovered from the schema module, so tests do not have
to enumerate them. `connectionUri` is for suites whose subject reads
`DATABASE_URL` itself (set the env, call `resetEnvCache()`). `seedSourceMessage()`
inserts a minimal mirror row for tests that add media directly — mirror first, ingest
second, exactly like the live pipeline.

### `test/setup-trace-store.ts`

Points the trace directory at a fresh temp path (`__setDataDirsForTests`) and resets
the trace-store singleton before every test. Traces live in files rather than the
database, so truncating tables would not isolate them.

### What integration tests cover

Persistence and the flows that only make sense end to end:

| File | Covers |
| --- | --- |
| `server/ingest/ingest.integration.test.ts` | The ingest stage against a real store — see below |
| `server/turn/turn-consumer.integration.test.ts` | The turn consumer: composed context in, delivery and lifecycle events out — see below |
| `server/source-store/source-store.integration.test.ts` | The conversation mirror and its directory |
| `server/owner-rights.integration.test.ts` | Owner rights through the person-link graph |
| `server/auth/auth.integration.test.ts` | Setup/login/session against the real accounts rows |
| `server/jobs/lock.integration.test.ts` | Advisory locks actually exclude |
| `server/status.integration.test.ts` | The health and status probes |
| `features/accounts`, `features/assistants`, `features/person-links`, `features/tool-connections`, `features/web-chat` (`server/*.integration.test.ts`) | The redesign's new persistence: accounts and self-link codes, assistants, links, remote MCP connections (discover/apply against `test/fake-mcp-server.ts`), web-chat threads |
| `features/*/server/*.integration.test.ts` (the rest) | Each feature's persistence, plus its job's idempotency |
| `packages/bus/src/bus.integration.test.ts` | Redis via Testcontainers (`redis:7-alpine`, the compose image): a queue job is delivered exactly once and a failure is **never retried** (`attempts: 1` — the turn runner owns re-enqueue), and pub/sub fans out and survives a poisoned message |

## Exercising the pipeline without Telegram

There is no simulation harness: the transport seam is the queue, so the two pipeline
stages are driven directly with the same event shapes the transport and the ingest
produce. Both suites need Docker and nothing else — the LLM is a stub.

### The ingest: `server/ingest/ingest.integration.test.ts`

Feeds **transport events** to `processTransportUpdate` — the function the
`transport-updates` worker calls — with the store pointed at a Testcontainers database
(`vi.mock("@/server/store/db")`) and the queue producer replaced by an array
(`vi.mock("@/server/turn/enqueue")`), so every turn the ingest would enqueue is
captured instead. Build a `transport.message` with `messageEvent({...})` (chat, sender,
content, media, the per-receiver structural verdict) and assert on the mirror rows and
on the `message.inbound` events it produced. It pins:

- a group message becomes a mirror row plus presence, and fans one turn out to each
  present assistant with its own verdict, correlation id and composed context;
- a `link-xxxxxxxx` self-link code is consumed (mirrored, marked processed, the
  identity joined to the account) and opens no turn;
- idempotency on the dedupe key; media stored and referenced on the turn; the history
  window composed from earlier mirrored traffic;
- `message.delivered` mirrors the assistant's reply and cross-feeds it to the *other*
  present assistants (never for silent sends);
- edits and bot reactions land on the mirror row; `transport.presence` stamps presence.

### The turn consumer: `server/turn/turn-consumer.integration.test.ts`

Drives `handleInboundJob(event, attempt, ctx, runTurn?)` — the `inbound-messages`
worker's job handler, which wraps `processInboundEvent` — with a synthetic
`message.inbound` event (`inboundEvent()` builds a fully addressed group turn with
history, participants and a reply anchor) and a `TurnConsumerContext` whose `publish`
collects the bus events, whose `markers` are the real `turn_actions` table, and whose
`overrides.generateReply` is the LLM stub. Set `process.env.DATABASE_URL` to the
container and call `resetEnvCache()`; the store reads it. It pins:

- an addressed turn: the composed prompt (transcript format, roster, notes, the
  sender's learned preferences and the latest self-correction), then `accepted` →
  `reply.delivery` → `settled`, with the action marker cleared;
- a web-chat turn (`source: "chat"`) delivers to the thread, tells the model it is in
  the web chat, and is traced with a `chat` trigger; a provisional thread title is
  generated once (`overrides.generateTitle`, `outbound.setChatTitle`);
- cross-fed turns from another assistant are attributed to it, and the loop guard
  goes silent at the configured run (`settings.assistant_loop_guard_turns`, default 3,
  0 = never answer each other) with a `skipped` reply trace;
- an unaddressed turn is ignored but still settled; a generation failure delivers the
  error notice and is **not** retried; a pre-action infrastructure failure is
  re-enqueued without settling; a failure after an action settles and never retries;
- media through a stubbed `mediaStore` + `describeDeps` (a pending photo is described
  and folded into the turn), voice turns answered from their transcript, and voice
  replies through a stubbed `outbound.sendVoice` — degrading to the text event when
  synthesis is unavailable.

Use these two as the template for a new pipeline behavior: build the event, stub the
one collaborator the behavior needs, assert on what was published and what was
stored. Nothing here touches Telegram, a token, or a model.

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

## The transport's own tests

`apps/tg` has a plain `vitest.config.ts` (no aliases — the app has no `@/` paths and
no `server-only` guard) and three unit files under `src/`: `addressing.test.ts`,
`inbound.test.ts`, `telegram-html.test.ts`. It has no integration suite of its own:
the transport is stateless, and what it forwards is proved on the core side by the
ingest suite above.

## Running a subset

```bash
cd apps/core && npx vitest run features/bot-messaging
```

```bash
cd apps/core && npx vitest run --config vitest.integration.config.ts features/memory
```

```bash
npm run test:watch
```

## CI

`.github/workflows/release.yml`'s `verify` job runs `npm run lint`,
`npm run typecheck` and `npm run test` — unit tests only, across every workspace. The
integration suite needs Docker and is not part of the release gate, so **run it
locally** when you touch persistence, migrations, a job's idempotency, or either
pipeline stage.

`npm run test` also carries the **wire-contract drift check**
(`packages/transport-sdk/src/wire.test.ts`): it regenerates
`docs/api/transport/{events.schema.json,openapi.yaml}` from the zod schemas and
fails when the committed copies differ. When it does, the fix is to run the
generator and commit its output:

```bash
npm run wire:generate -w @assistant-hub-swarm/transport-sdk
```

`npm run typecheck` and `npm run test` declare `dependsOn: ["^typecheck"]` in
`turbo.json`, so a change to a package invalidates the cached result of every
workspace that compiles against it. Without that, turbo happily serves a stale
pass — which is how a transport that no longer compiled against the contracts
package once went green here.

CI uses `npm install` rather than `npm ci` for the same lockfile reason as the
Dockerfiles: the lockfile is generated on Windows and omits Linux-only optional native
dependencies.

## What to write for a new feature

| Change | Test |
| --- | --- |
| A pure decision (addressing, schedule math, formatting, parsing) | Unit test, colocated. Non-negotiable |
| A repository or a migration | Integration test against a real database, through `startTestStoreDb()` |
| A background job | Integration test proving idempotency: run it twice, assert the second run is a no-op |
| An LLM-derived job | Unit-test the prompt builder and the parser separately. The parser is the fail-closed boundary — test the garbage cases |
| A new MCP tool | A tool-selection test for the phrasings it should and should **not** win |
| A Route Handler | Its behavior is mostly the shared wrapper's; test the service instead, plus schema tests for the contract |
| A new event shape between the apps | A schema test in `packages/contracts`, and a case in the ingest or turn-consumer suite that feeds it through |
| A live-provider phrasing you had to handle | Pin the phrasing in a test, so a provider upgrade that changes it fails loudly |

## Things that are hard to test, and how they are handled instead

| Concern | Approach |
| --- | --- |
| Real browser behavior | Live integration tests marked `*-live`, plus pure tests for the snapshot script builder and HLS parsing |
| Telegram API | The queue seam — the ingest and the turn consumer run against real Postgres with the transport's events built by hand and every send captured |
| Redis | Testcontainers in `packages/bus`; the core suites replace the queue producer with an array |
| Model quality | Not asserted. What *is* asserted: tool selection, that verdicts require real citations, and that parsers fail closed |
| Timing/scheduling | The scheduler shapes are pure and directly unit-tested; the tickers themselves are thin |
