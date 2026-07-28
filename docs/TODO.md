# TODO

The working tracker for pending work. It replaced `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md` (retired 2026-07-27): the v1 rewrite is complete,
so the phase plan, per-feature progress tables, session logs and the historical
Decision Notes are archive material — recoverable from git history — and only
the still-actionable information was carried forward here.

How to use this file:

- Update it before and after substantial work; statuses are `todo`,
  `in-progress`, `blocked`, `done`, `deferred`.
- A `done` entry records proof (files changed, tests run, build/typecheck/lint
  status, remaining risks) — and is then **pruned** once the work is shipped and
  documented under `docs/`. Git history is the archive; this file holds only
  open work.
- A `blocked` entry records the blocker, the attempted approach, and the next
  decision needed.
- Decisions are made by asking the user and recording the outcome against the
  entry it belongs to, here (no `docs/decisions/*.md` files).
- At handoff, leave short notes here: current state, next best task, known
  pitfalls, commands that passed or failed.

## Current state

v1 (priorities 1–14 in `AGENTS.md`) is complete and deployed: the app
independently runs the bot, dashboard, persistence, background jobs and Docker
deployment. Priorities 5–6 (search / read-link MCP tools) were later
superseded — `browse_web` is the only web tool (user decision, 2026-07-26).

## Voice/vision trace + describe-race overhaul (`done`, 2026-07-27)

Root cause of the "transcription succeeded but the bot said it couldn't hear"
incident (trace `11162be5…` / `69761c50…`): `describeAndStore` handed the
transcript back only through `markDescribed`'s row, which returns null when a
concurrent pass described the row first — the caller then read `description:
null` from the stale pre-read row and told the model transcription failed,
while the trace recorded a clean success. All user decisions 2026-07-27:

- **One reply trace per incoming message.** Live transcribe/describe passes
  record into the `bot-messaging`/`reply` trace (`describeAndStore` takes an
  optional parent `TraceRecorder`; the runtime opens the reply trace before
  eager voice transcription via `startReplyTrace` and the service adopts and
  settles it on every path). Standalone `voice`/`transcribe` and
  `vision`/`describe` traces remain only for backfill/probe passes. Side
  effect (accepted): the `/debug` voice/vision feature filters now show only
  those standalone traces; live passes are inside reply traces. Analytics is
  unaffected — usage events carry explicit `callKind`.
- **Honest describe results.** `describeAndStore` returns the text it produced
  or found: a lost `markDescribed` race re-reads and reuses the winner's text
  (warn event), an already-described row is reused without an LLM call, and a
  parent-trace failure becomes a warn event + null, never a fake success.
- **`message_media` → `chat_messages` FK** on `(chat_id, telegram_message_id)`
  (cascade): media never floats free of the mirror. Migration `0041` sweeps
  orphans first (stub mirror rows for `described` orphans, delete the rest).
  Consequences implemented: media from bot-authored messages is no longer
  ingested (was also wasting transcription calls on other bots' voice), and a
  mirror failure now blocks media handling (warn event on the reply trace).
- **Live-processing semaphore** `chat_messages.processed` (user-proposed): the
  live pipeline mirrors with `false` and releases to `true` in `processUpdate`'s
  `finally`; `listPendingMedia` only returns released rows, with a **10-minute
  timeout** fallback so a crashed pipeline can't hide a row forever. This is
  DB-level, so it also fences a backfill in another process sharing the DB.

Proof: files — `db/schema.ts`, `db/migrations/0041_slimy_molten_man.sql`,
`features/vision/server/{service,repository,backfill}.ts`,
`features/history/server/{service,repository}.ts`,
`features/bot-messaging/server/service.ts`, `server/telegram/process-update.ts`,
`server/trace/{recorder,store,with-trace}.ts` (new `setInputSummary`),
`test/db.ts` (`seedMirrorMessage`), docs (`vision.md`, `voice.md`,
`history.md`). Tests: new coverage for the write-race reuse, parent-trace
nesting, re-delivery reuse, semaphore gating + timeout, pre-opened-trace
settlement; `npm run lint`, `typecheck`, `test`, `test:integration`, `build`
all green (see handoff note below if any flipped). Migration applied to the
dev DB. Remaining risk: the production incident's *second* transcriber was
never identified from the two exported traces alone — if it recurs, check the
trace list for the correlation id and whether another process shares the
production DB.

## Priority 15 — Specialists (`done`, 2026-07-27)

Implemented per the user-decided design of 2026-07-27 (now documented in
`docs/features/specialists.md`): operator-only `/specialists` CRUD, one shared
MCP data toolkit over a unified `specialist_entries` store (free-text
collection + JSONB payload), per-chat activation stacking base + personality +
specialist, in-tool switch gating (self-serve in own DM, owner-only in
groups), the per-specialist `per-chat`/`shared` data-scope flag, proactivity
via the existing scheduled-tasks engine, and three editable seed rows.

Implementation choices within the decided guardrails (values were unspecified):
payload cap 16 384 bytes/entry, query cap 50 results, collection label ≤128
chars, max 32 specialists (the personalities bound). Load-bearing integration
delivered by making scheduled-task fires run with the full registered toolset
(`chatCompletionWithTools`) inside the task chat's tool context — so a
specialist's check-in queries its own entries mid-fire; tool calls are
recorded on the fire trace as `external_call` events.

Proof: files — `db/schema.ts` + migration `0042_next_iron_monger.sql` (three
tables + seeds; **applied to the dev DB**), `features/specialists/*`
(schema/repository/service/mcp-tools/UI), `app/api/specialists/**`,
`app/(dashboard)/specialists/page.tsx`, `lib/features.ts`
(`specialists` + `mcp-tools-specialists`), `lib/realtime.ts` (`specialists`
topic), `server/mcp/runtime.ts`, `components/layout/nav-config.ts`,
`features/bot-messaging/server/{prompt,service}.ts`,
`server/telegram/process-update.ts`,
`features/scheduled-tasks/server/{fire,scheduler}.ts`, docs
(`docs/features/specialists.md`, features README, AGENTS.md). Tests: new
`specialists.integration.test.ts` (18: seeds, CRUD, assignment, switch gating
DM vs group, scope silos, caps, browser, traces), `mcp-tools.test.ts`
(no-active-specialist result, save normalization, switch relaying), prompt
stacking + fire-path composition/tool-context tests added to existing suites.
`npm run lint`, `typecheck`, `test` (716), `test:integration` (311 passed / 31
skipped — the live-LLM-gated ones), `build` all green. Remaining risks: the
dashboard page was verified only by build + tests (operator auth blocks an
agent from logging in — check `/specialists` renders after the next dev-server
restart, which is also when the new MCP tools appear, registry being
boot-bound); gemma4:12b tool-selection quality over the new toolkit is
unmeasured — if the model ignores `specialist_*` tools live, tune the seed
instructions/tool descriptions like the tasks tools were.

## Other open items

- **Ukrainian idiomatic joke requests never trigger tools on gemma4:12b
  (`blocked` on a model decision;** from the 2026-07-27 "lied about scheduling"
  trace `64067530…`**)** — a persona-mode, third-person recurring gag request
  in idiomatic Ukrainian ("let \<persona\> send everyone ... once a day",
  phrased colloquially) made the model claim it had scheduled the task without
  calling `tasks_create`. Fixes landed: the base prompt's Honesty rules now
  bind action claims to tool calls (in character too), the Conversation rules
  treat third-person requests about the bot as requests to it, and the
  `tasks_create` description covers joke/third-person recurring phrasings —
  verified live: the model no longer fabricates the action, and both the
  identical English joke phrasing and a plain Ukrainian daily-reminder request
  now select `tasks_create`. But the idiomatic-Ukrainian variant failed 5/5
  live runs — a cross-lingual gap in gemma4:12b itself. The English variant is
  pinned in `features/scheduled-tasks/server/tool-selection.integration.test.ts`;
  the Ukrainian one is deliberately NOT pinned in code (no Cyrillic in code —
  user rule, 2026-07-27) and lives only in the exported trace. Next decision
  needed (operator): try a stronger/tool-tuned model in Settings for the reply
  path, or accept the gap; re-verify against the trace phrasing after any
  model change. Related observation feeding the same decision: the plain
  English "what reminders do I have?" live case intermittently fabricates a
  full reminder list without calling `tasks_list` (seen 2 of ~6 live suite
  runs, 2026-07-27) — same bluffing pattern, worth including when evaluating a
  replacement model.

- **Context-free reminders + bluffing instead of searching history
  (`in-progress`;** from the 2026-07-28 traces `257ad4e9…` and `925ecf31…`, plus
  the operator's account of how the task was set up**)** — one incident, two
  defects, at opposite ends of the same feature.

  *What happened.* A person was discussed in the chat over several days. A user
  asked the bot to remind another participant daily who that person is. The bot
  created a scheduled task whose instruction was the surface phrasing of the
  request ("remind X who \<person\> is") rather than the substance, so every fire
  delivered that sentence back — a reminder that points at a fact instead of
  carrying it. When the reminded user then asked outright who the person was, the
  bot never called a history tool across five consecutive turns
  (`finish_reason: stop`, zero tool calls, all 21 tools offered), accused them of
  faking amnesia, and answered with an empty metaphor. Its own reasoning trace
  states it cannot find the term, then improvises anyway.

  *Root cause of the reminder half.* `fireScheduledTask` composes base prompt +
  persona + specialist + language + directive and **loads no transcript at all**
  (`features/scheduled-tasks/server/fire.ts`), so the firing model has no way to
  know what the instruction refers to. `tasks_create` only ever asked for a
  "self-contained" instruction without saying that self-contained means carrying
  the facts.

  *Fixes landed* (design decision — operator, 2026-07-28: fix at **both** ends
  rather than either alone, since a 12B model may miss either step):
  1. **Grounding** block in `BASE_SYSTEM_PROMPT`
     (`features/bot-messaging/server/prompt.ts`) — factual claims limited to
     transcript / durable memory / this-turn tool results; searching history is
     mandatory for an unfindable reference; "I don't know" is an acceptable
     answer; covering a gap by accusing the asker is forbidden; the persona
     governs tone and never truth.
  2. **`TASKS_CREATE_DESCRIPTION`** (extracted to an exported constant so it can
     be pinned) — states that a fire sees only the instruction text, requires
     `history_search` → `history_get_in_range` before creating a task that
     references chat-specific people/events/topics, requires the findings be
     written into the instruction, and says to ask the user rather than store an
     empty pointer. Same rule echoed on the `instruction` field of
     `tasks_create`/`tasks_update`.
  3. **`buildTaskDirectiveMessage`** (`fire.ts`) — second line of defence: tells
     the fire it has no transcript, to look the reference up in history before
     writing, and to be honest rather than parrot the directive when the lookup
     comes up empty. The fire already runs with the full toolset bound to the
     task's chat, so the lookup is available.

  Files changed: `features/bot-messaging/server/prompt.ts` + `prompt.test.ts`,
  `features/scheduled-tasks/server/mcp-tools.ts` + `mcp-tools.test.ts`,
  `features/scheduled-tasks/server/fire.ts` + `fire.test.ts`. Verified:
  `npm test` (74 files, 727 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  **Remaining risk / next step (operator):** unverified live — all three fixes
  are prompt/description text, and this is the same gemma4:12b tool-avoidance
  pattern as the `tasks_list` fabrication in the item above, so the model may
  ignore them exactly as it ignored the tools. Re-run both halves live (create a
  reminder that references a chat-only topic; then ask the bot what that topic
  is). Existing thin task instructions are deliberately **not** migrated —
  operator fixes those through the bot (decision, 2026-07-28). If the model still
  refuses to search, this folds into the same model-replacement decision.

- **Traces bind-mount permissions (`blocked` on an operator decision;** from
  the 2026-07-22 prod data-loss incident**)** — Docker auto-creates
  `./data/traces` root-owned while the app runs as the non-root `app` user, so
  trace flushes fail with EACCES (now surfaced via the data-loss banner, the
  Overview card and `/api/health`). Host-side workaround: chown the bind mount
  to the container's `app` uid. The permanent Dockerfile fix (root entrypoint
  chowns the mount, then drops to `app` via su-exec) was proposed but not
  implemented — a container security-posture change that needs the operator's
  decision.
- **Search-engine cascade (operator's call)** — engines rank themselves by
  success stats, so the blocked-engines-first configured order self-heals; the
  open question is adding **Brave** as a fourth engine (measured best on
  2026-07-26: 45 relevant results).
- **Memory General-knowledge cleanup (verify)** — the wrong pre-fix lines in
  the General knowledge document (2026-07-17 incident) needed manual removal on
  `/memory`; the pruning merge only runs when a new `general` note arrives.
  Verify the cleanup happened; drop this item if it did.
