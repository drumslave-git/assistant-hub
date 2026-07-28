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

## Memory scope placement — `general` holds outsiders again (`done`, 2026-07-28)

*What happened.* Trace `833006d7…`: a user told the bot to remember, once and for
all, who a person discussed in the chat is. The model called `memory_save` with
`scope: "general"`, the tool returned `saved: true`, the bot replied "записав",
and the 17:20 consolidation run reported `general knowledge updated`. The fact was
nowhere afterwards. `GENERAL_MERGE_PROMPT` had been told biography "is a line to
drop" (2026-07-17 rule), so the merge correctly excluded it — and
`runMemoryConsolidation` deletes every note in the batch whenever the merge
returns a non-empty document, kept or not. Confirmed promise, silent loss.

*Decision (operator, 2026-07-28), reversing 2026-07-17.* Placement is decided by
**who the fact is about**: someone this chat knows → `user`; anyone else →
`general` is the right home, name written into the fact. The two follow-ups
offered — "don't delete what the merge didn't keep" and "surface the discard" —
were explicitly declined; the gate is the fix.

*Fixes landed.*
1. **Gate, both directions** (`features/memory/server/service.ts`) —
   `resolveMemorySubject` (chat-scoped reference → known-user id; a reference
   matching nobody now points the model at `general` instead of "drop the fact")
   and `checkGeneralNoteSubject` (a `general` note whose declared `person`
   resolves to a chat participant is refused and sent back as `user`). Both are
   service-level, so the `memory_save` tool and passive extraction clear the same
   bar (extraction already writes through `saveMemoryNote`, and its rejections are
   already traced as warnings).
2. **`mcp-tools.ts` thinned** — the old local `resolveSubjectId` is gone;
   `memory_save`/`memory_get` call the service. Tool description rewritten: which
   scope a person-fact belongs in, and that `person` is meaningful for `general`
   too.
3. **Prompts realigned** — `UNIDENTIFIED_PERSON_RULE` now says "save it as general
   with their name in" (shared by the tool and `EXTRACTION_SYSTEM`);
   `GENERAL_MERGE_PROMPT`'s biography ban replaced with "keep every named fact",
   retaining the never-merge-two-people guard that makes the reversal safe;
   extraction's `general` scope line and empty-roster fallback updated to match.

Files changed: `features/memory/prompt.ts` + `prompt.test.ts`,
`features/memory/extract-prompt.ts` + `extract-prompt.test.ts`,
`features/memory/types.ts`, `features/memory/server/service.ts`,
`features/memory/server/mcp-tools.ts`,
`features/memory/server/memory.integration.test.ts` (new `subject placement`
block), `docs/features/memory.md`, `docs/architecture/data-model.md`,
`docs/architecture/llm-and-mcp.md`.

Verified: `npm test` (75 files, 741 passed), `npm run lint`, `npm run typecheck`,
`npm run build` — all clean. **`npm run test:integration` could not be run** on
this machine: testcontainers finds no container runtime (`docker` is not
installed), so the new `subject placement` tests are unexecuted — run them where
a runtime exists.

*Remaining risks.*
- The gate only sees the subject the model **declares**. A `general` save that
  names no `person` is taken at its word, so a person-fact can still slip in
  unfiled. Content-scanning was considered and rejected: the triggering fact
  ("Muradyan is a friend of \<user A\> who pranked \<user B\>") names two known
  people incidentally while being about a third, so a mention-based guard would
  have rejected exactly the fact this change exists to keep.
- The merge can still fail to carry a note forward for its own reasons, and the
  batch is still deleted either way (declined above). A note lost that way is
  still silent.
- The 2026-07-17 failure mode (name-keyed lines merging across people) is now held
  off by prompt text alone in the merge, plus the gate keeping known people out.
  Watch `/memory` → General knowledge for two outsiders collapsing into one.

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

  *Live re-test of the reply half: failed* (trace `f79f84a2…`, 2026-07-28). Asked
  "хто такий Мурадян?" the bot again called no tool and again answered with a
  metaphor. Its reasoning block names the source explicitly: *"looking at my
  previous response (#13164), I defined it as a symbol of bypassing direct routes"*,
  padded with general knowledge (*"in common underground/internet/tech contexts
  (especially in Ukraine), 'Muradyan' often refers to…"*). The term occurs five
  times in the 24-hour window: twice asserted by the bot, three times as
  participants asking what it means. **No human ever said what it is** — the bot
  invented it, then read its own invention back as established fact.

  *Root cause of the miss.* Grounding declared "the transcript" a source
  wholesale, and a bot line is transcript. The rule's own bot-specific clause
  ("if you cannot back it up, say so") reads as being about *honesty under
  challenge*, not about *what counts as evidence*, so a self-confirming loop
  passed it.

  *Second round of fixes* (design decision — operator, 2026-07-28: **rank the
  sources**, prioritize user-sourced information over bot-sourced; enforcement
  stays in the prompt — *"we never solve model problems by code"* — so no gating,
  forced retrieval, or verifier pass):
  4. **Grounding** rewritten around source rank: fact = what a *person here*
     said, durable memory, or a this-turn tool result. The bot's own messages are
     "never a source" and are declared unreliable outright — wrong, stale,
     polluted by the conversation, or invented. People outrank the bot; a user
     correction is taken as correct. A term appearing *only* in the bot's own
     lines is named as the not-known case, with re-deriving a meaning from its
     own earlier wording forbidden. Mirrors what memory extraction already does
     (`EXTRACTION_SYSTEM` refuses to harvest facts from bot lines).
  5. **`TRANSCRIPT_PREAMBLE`** (`features/history/server/format.ts`) — says it at
     the point of use: the other people's lines are what was said, the bot's own
     are not evidence and may be wrong or invented.
  6. **History tool results carry provenance**
     (`features/history/server/mcp-tools.ts`) — each line names its author in
     words (`a participant` / `you (the bot)`) instead of the wire role, and a
     result whose every row is bot-authored appends
     `SELF_AUTHORED_ONLY_NOTE` ("…this result confirms nothing… Treat this as not
     found."). The only code-side change, and only because the prompt's source
     ranking is unusable if a lookup hands back rows without saying whose they
     are. `structuredContent.role` is unchanged for machine consumers.

  Files changed (round 2): `features/bot-messaging/server/prompt.ts` +
  `prompt.test.ts`, `features/history/server/format.ts` + `format.test.ts`,
  `features/history/server/mcp-tools.ts` + new `mcp-tools.test.ts`. Verified:
  `npm test` (75 files, 739 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  **Remaining risk / next step (operator):** still unverified live, and still the
  same gemma4:12b tool-avoidance pattern as the `tasks_list` fabrication in the
  item above — round 1's prompt text was ignored, and round 2 is more prompt
  text, so the model may ignore it too. Re-run live: ask the bot who "Мурадян" is
  again; a pass is "I don't know / nobody here ever said". Also re-run the task
  half (create a reminder that references a chat-only topic; then ask the bot
  what that topic is). Existing thin task instructions are deliberately **not**
  migrated — operator fixes those through the bot (decision, 2026-07-28). If the
  model still refuses to search, this folds into the same model-replacement
  decision. Known remaining laundering path, not addressed: `history_recall_topics`
  serves daily topic summaries, which are written over both sides of the
  conversation — a bot-invented term can therefore re-enter through a summary
  with no author attached. Decide whether summaries should mark, or exclude,
  bot-sourced content.

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
