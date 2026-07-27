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

## Priority 15 — Specialists (`todo`)

Operator-authored bot roles ("specialists") that store, operate on and analyze
their own data, and proactively message the chat. The user's examples: a daily
psycho journal with analysis, grocery management, a planning advisor. Added by
the user 2026-07-27; every design point below is a user decision from the same
day. No schema, code, seeds or migrations exist yet.

### Design (all user-decided, 2026-07-27)

- **Authoring — operator-only, via a `/specialists` dashboard CRUD page** (the
  personalities pattern): name, description, instructions, data-scope flag.
  Telegram users use specialists but never author them. Rejected:
  conversational authoring by Telegram users; a tiered catalog with per-user
  private specialists.
- **Anatomy — prompt + one shared toolkit; no per-specialist tables, schemas
  or code.** All specialists share one generic MCP data toolkit (save / query /
  update / delete entries) over a single unified `specialist_entries` store:
  specialist id, chat id, author user id, a free-text `collection` label the
  model picks, and a JSONB payload whose shape the model decides — the skills
  model: instructions over shared tools. Toolkit tools stay always-registered
  (the registry convention) and return a clear "no specialist is active in
  this chat" result when unscoped; each description self-describes. Guardrails:
  payload-size cap per entry, result cap per query, **no retention/expiry in
  v1**. Rejected: author-declared collections with field schemas (revisit only
  if freeform shapes prove too messy for the local model); code-level plugins.
- **Activation — per chat, default none.** A new chat→specialist mapping (the
  active personality stays a single global setting — deliberately different).
  Deactivating returns the chat to the no-specialist default. Prompt
  composition **always stacks**: base system prompt + active personality +
  specialist instructions. Rejected: global or per-user activation; a
  replace-personality mode; a suppress-personality toggle.
- **Switching — self-serve in own DM, owner-only in groups.** Surfaces: an MCP
  switch/list tool plus dashboard per-chat assignment (no Telegram command
  menu). Permission is enforced **inside the tool** (the browser-downloads
  owner-gate precedent; no lexical pre-filter — a denied caller gets a refusal
  the model relays): in a private chat the user may switch their own chat's
  specialist; in groups only the owner (settings owner identity). User's
  wording: *"users can switch specialists in their own dm chat, in groups -
  only by owner."*
- **Data scope — a per-specialist flag**: `per-chat` (default — each chat is
  its own silo; right for the journal) or `shared` (one pool across every chat
  where it's active; right for a grocery list reachable from both the family
  group and the owner's DM). Per-chat filters on (specialist id, chat id);
  shared filters on specialist id alone. Entries always record chat + author
  user id as provenance. Rejected: always-per-chat; always-shared.
- **Proactivity — self-scheduling via the existing scheduled-tasks engine
  only.** A specialist keeps itself proactive by calling the existing
  scheduled-tasks MCP tool (e.g. "keep a daily 21:00 check-in scheduled");
  fires deliver through the existing poller + `sendChatMessage`. **The
  load-bearing integration: the scheduled-task fire path must compose the
  firing chat's active specialist context (instructions + toolkit scope)
  exactly like the live reply path** — otherwise the check-in wakes up as the
  generic bot. Analysis is not a separate engine: "how was my week" is the
  model querying its own entries, and digests are self-scheduled tasks.
  Rejected for v1 (each needs a new decision): an author-defined cron field;
  data-driven triggers on stored entries.
- **Seeds — three editable seed specialists ship with the feature**: daily
  psycho journal (with analysis), grocery management, planning advisor —
  ordinary editable rows, not fixtures, so the operator tunes
  instructions/tone/language afterward.
- **Memory-feature overlap — deliberately orthogonal in v1** (user: "leave for
  now"): specialist-driven chatter stays visible to the nightly memory
  extraction. Revisit only if the memory documents actually get polluted.

### Acceptance criteria

The standard feature contract (`docs/development/contributing.md`), plus:

- `/specialists` dashboard page: CRUD, a per-chat assignment view (every
  chat's active specialist, assign/clear), and an entries browser (filter by
  specialist/chat/collection, full raw JSON payloads, live via SSE).
- Feature registration in `lib/features.ts`; traces for
  switch/save/query/prompt-composition with full raw bodies;
  `/debug?feature=specialists` + tool scope `mcp-tools-specialists`.
- Migrations generated **and applied** to the dev DB.
- Tests: service, routes, toolkit (incl. the no-active-specialist result),
  switch gating (DM vs group), scope-flag queries, prompt composition incl.
  the scheduled-fire path, seeds.

### Suggested implementation order

1. Schema (specialists table, chat→active mapping, `specialist_entries`) +
   service + the generic toolkit.
2. Prompt composition — the live reply path **and** the scheduled-task fire
   path.
3. `/specialists` dashboard page, seeds, debug wiring.

Known pitfalls: the MCP registry and the schedulers are boot-bound singletons
(new tools are not offered until a dev-server restart), and `db:generate` must
be followed by `db:migrate` on the dev DB.

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
