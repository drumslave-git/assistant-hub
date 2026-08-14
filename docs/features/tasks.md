# Tasks

One instruction plus one trigger — the unified feature that absorbed scheduled
tasks and chat rules (user decision, 2026-08-13). *"From now on, whenever
someone posts a video link, download it"* and *"every morning at 9, nudge us
about standup"* are the same thing to the bot: work it carries out on its own,
written in the author's words. Nothing about a task is code — the instruction is
the contract, and it is carried out with the tools the bot already has.

Feature ids: `tasks` (CRUD, fires, and the match decision), `mcp-tools-tasks`
(the toolkit's calls). Dashboard: `/tasks`. Debug: `/debug?feature=tasks`.

## Trigger kinds

| Kind | Fires when | Family |
| --- | --- | --- |
| `message` | An incoming chat message matches the instruction (LLM matcher) | prompt |
| `on-reply` | Never on its own — composed into every reply prompt (the old shaping rules) | prompt |
| `interval` | Every `every_minutes` minutes | timed |
| `timeout` | Once, `delay_minutes` after creation | timed |
| `schedule` | Calendar: once on a date, daily, or on chosen weekdays, at `HH:MM` in the operator timezone | timed |

The two **families** share the row but not the rules:

- **Prompt kinds** are the old chat rules: capped at **32 per scope** (every one
  is in every prompt), deduplicated by instruction, may be **global**
  (`chat_id null` — applies in every chat on top of the chat's own), may name
  the people they apply to, and carry no saved context (they run inside a live
  turn that has its own).
- **Timed kinds** are the old scheduled tasks: uncapped, chat-bound (a fire
  needs somewhere to speak), carry an optional `context` gathered at creation
  (a fire sees no transcript), and keep the one-shot retry lifecycle — a failed
  due one-shot retries on later ticks up to **5 attempts**, then is disabled,
  never deleted; a fired one-shot is deleted, spent.

## How a fire executes — no hardcoded sending

A timed fire runs a full tool loop, exactly like a reply turn plus the
**outbound tools** — and nothing else delivers (user decision, 2026-08-13). The
completion's final text is traced, never sent:

- `send_message` (tasks feature, fires only) sends a standalone message to the
  task's chat.
- `reply_to_message` (bot-messaging, every turn) attaches what is said to one
  earlier message; in a fire it *is* the delivery, in a reply it retargets the
  reply as before. One tool name, one user-facing concept, dispatched on the
  context's `deliver` binding.

The fire binds `deliver` on the MCP tool context
(`server/mcp/context.ts`); `getToolset({ outbound: true })` is asked only by the
scheduler, so a reply turn never even sees `send_message` (its own text already
delivers itself — offering a send tool there would invite a double-send), and
the handlers refuse without the binding, so a stale registry cannot smuggle a
send into a reply either.

**Silence is a feature.** A fire that calls no send tool is a *quiet fire* —
"check X, message only if Y" is now expressible — recorded as a success with
the model's internal note in the trace. A fire that *attempted* delivery and
got nothing through is a failure and retries (one-shots) or self-heals on the
next occurrence. Every delivered message is mirrored into history and counts
into the capped `recent_deliveries` (wording variation, labelled bot-authored
in the next fire's prompt).

Cross-chat sends do not exist: the outbound tools are bound to the task's own
chat like every chat-bound tool.

## Message triggers — the matcher

A `message` task acts on messages nobody addressed the bot in. This is the one
path by which the bot speaks unprompted about someone's message, so it is
deliberately expensive and hard to trigger:

1. The addressing check runs first and says "not addressed", as always.
2. *Only if the chat has at least one enabled `message` task for this sender*,
   one classification call asks which tasks the message triggers
   (`features/tasks/server/matcher.ts`).
3. The model must name a task by its offered number **and** quote the part of
   the message that triggers it; the quote is checked mechanically. An unknown
   number, a missing/invented quote, an unreadable answer, or a failed call all
   mean **no match** and the message stays ignored.
4. On a match, the ordinary reply pipeline runs with a directive injected last
   naming the matched tasks. The turn keeps the full reply machinery — context,
   vision, the browse-ack flow — and its reply is delivered as a reply to the
   triggering message. Enforcement is unchanged: a task-opened turn that calls
   no tool is retried once with `TASK_ENFORCEMENT_DIRECTIVE`, then suppressed
   with an honest system notice, and the trace fails.

Maintenance mode turns the matcher off, exactly as it turns the addressing
analyzer off. The matcher reads the message's *words*: a bare photo or sticker
has nothing to quote and cannot match.

### What the matcher is shown about people

A task limited to particular people is offered as `if message from <label>:
<instruction>`, and the sender is named over the message. Labels, not ids — the
model compares two names (`getUserLabels` resolves both in one read). Without
this, a per-person task never fires (2026-08-13, trace `c08283a8…`): its
condition is who is speaking, which the words cannot contain. The system prompt
walks a task in two steps — who it applies to (compare names, never search the
message), then what it asks of the message — because each direction failed
live without its half: the first phrasing that made person-only tasks fire also
made a targeted task with a content condition fire on everything its person
said (6 runs of 6). Both directions are pinned in
`live-matcher.integration.test.ts` (`LLM_LIVE=1`, 6 runs per case). The
citation guard has no exemption: a task that asks nothing of the words quotes
the message itself, which passes by construction.

## Who a task applies to

A prompt task applies to **everyone in its chat** by default; one scoped to a
**group** may instead name up to **16** people (`target_user_ids`), and then
applies to their messages and nobody else's. It is a hard filter on the sender,
applied in `getActiveTasksForChat` *before* anything is composed — a task about
one member never reaches another member's prompt or the matcher. A timed fire
passes a null sender and gets exactly the tasks that name nobody.

Only groups can narrow (a DM is one person; a global task spans unrelated
rosters), and only people the bot has **seen speak** in that group can be named
— checked against the `group_members` roster, so an invented id is refused
rather than stored as a task that silently never fires. Names are never
resolved to ids in code: the group roster injected into every group prompt
carries each participant's exact id, and the model copies one.

## Whose rights a task-driven action carries

**A task is its author's standing order** (user decision, 2026-07-29 — "rule
creator beats message source"). When the bot acts because a `message` task
matched, the action runs with the rights of whoever set the task:
`resolveTaskAuthority` elevates exactly when a matched task was written by the
**owner** in chat or by the **operator** in the dashboard, and the runtime binds
the result as `authorityUserId` on the per-turn tool context. Permissions only —
provenance (`userId`) stays the real sender. The matcher also runs on addressed
turns (skipped when nothing could elevate), so the answer is the same whether or
not the person happened to name the bot. Restricted rule-driven downloads are
unchanged — see `docs/features/browser-agent.md`.

## Two ways in

| | Dashboard `/tasks` | The chat itself (`tasks_*` tools) |
| --- | --- | --- |
| Who | The operator (the dashboard is operator-only) | Gated — see below |
| Scope | Any chat, **and** the global set (prompt kinds) | Only the current chat |
| Audience | Everyone, or people ticked off the group's roster | Everyone, or `user_ids` copied from the roster |
| Global tasks | Create, edit, delete | Visible, never editable |

Chat-side gates are enforced **inside the service** (no lexical pre-filter),
and a denial is returned, never thrown, so the model relays the refusal:

- **Prompt kinds** keep the rules gate (user decision, 2026-07-29): self-serve
  in a private chat, owner-only in a group.
- **Timed kinds** keep the scheduled-tasks gate: anyone in the chat may create;
  a task is changed or cancelled by its creator, or by the owner (exemption:
  user decision, 2026-08-07), judged on the turn's *authority*.

A task of another chat is invisible (`not_found`); a global task is visible but
read-only from chat. Creating a **standing** task from chat is idempotent: the
same instruction again returns "already in force, unchanged" (trace
`f33e1ede…`, 2026-07-29 — a tool that punishes a repeat teaches the model to
reassure in prose instead of calling), while the same instruction with a
*different audience* amends the audience and says so. The dashboard still gets
a 409 for duplicates — an operator must see a no-op for what it is.

## Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `tasks_list` | — | This chat's tasks with ids, triggers, and audience, plus the global ones |
| `tasks_get` | `id` | One task, including its saved context |
| `tasks_create` | `instruction`, `trigger`, `context`, `user_ids`, `every_minutes`, `delay_minutes`, `time`, `weekdays`, `date` | Save a standing rule or a timed job |
| `tasks_update` | `id` + any of the above, `enabled`, `applies_to_everyone` | Reword, retime, retarget, pause/resume |
| `tasks_delete` | `id` | Remove a task for good |
| `send_message` | `text` | **Fires only** — deliver a message to the task's chat |
| `reply_to_message` | `message_id`, `text` | Attach what is said to an earlier message (bot-messaging; `text` used in fires) |

`tasks_create`'s description is long by design and pinned in tests: it carries
every behavioural rule its two predecessors earned in production — the many
phrasings of a rule and of a schedule request, memory-tool disambiguation,
trigger selection ("in 5 minutes" is `timeout` with `delay_minutes` 5, "every
10 minutes" is `interval`), gather-context-before-creating for timed kinds
(2026-07-28: a fire sees no transcript), repeat-is-safe idempotence
(`f33e1ede…`), and roster-copied `user_ids` (never derived from a name).
`tasks_update` keeps two audience fields (`user_ids` + `applies_to_everyone`)
so an empty array means "leave it alone" and can never silently widen a rule
written about one person. Unknown ids answer with the chat's real ids to copy
from (2026-08-05 — a truncated id used to read as "the task vanished").

## Scheduler

A fixed-interval poller (30s tick, `globalThis` singleton, cross-process
advisory lock) scans enabled timed rows whose `next_run_at` is due, fires each,
then settles: an `interval` advances from the settle instant (drift over
double-fire), a `schedule` advances on the calendar, a spent one-shot is
deleted, a failed one is retried/disabled. Fires pause during maintenance mode
(skipped, not dropped). Each fire composes the chat's specialist, language, and
the standing-tasks block (null sender), and runs with the task's chat bound as
the tool context. Job card on `/tasks` and `/jobs`; "Run due now" via
`POST /api/tasks/run`.

## Where a standing task lands in the prompt

`buildStandingTasksBlock` composes the enabled prompt tasks for the sender;
`buildSystemPrompt` appends it **last**, after personality, specialist, and
self-correction — these are explicit instructions the people in the chat gave
the bot, and they are what the reply is judged against. The block's closing
paragraph binds an action to a tool call in the same turn and licenses an
honest "could not". Timed fires get the same block: a rule about how the bot
speaks governs what it sends unprompted too. The model-facing wording still
says "standing rules" — that is what these are to the people in the chat;
"task" is the codebase's name for the row.

## Storage

One table, `tasks` (migrations `0054` drops `chat_rules` + `scheduled_tasks` —
a clean cut, user decision 2026-08-13 — and `0055` creates `tasks`). See
`docs/architecture/data-model.md` for columns. Scope is **not** editable
(moving a task between chats is delete + create); the trigger, audience,
timing, and context are.

## Traces

Every mutation is traced under `tasks` (`create`/`update`/`delete`) and every
fire as `tasks`/`fire` (usage `callKind: "task-fire"`), with the task id in
`relatedIds.tasks` and, when a fire delivered, the `<chatId>:<messageId>`
correlation so feedback can find it. The match decision is recorded on the
reply trace of the message it judged (`callKind: "task-match"`, a `task match`
step with the offered tasks, matches, and the bound `authorityUserId`). Tool
calls are traced under `mcp-tools-tasks`.

## Tests

| File | Covers |
| --- | --- |
| `features/tasks/schedule.test.ts` | Trigger math: wall-clock conversion, per-kind next-run, normalization, summaries |
| `features/tasks/format.test.ts` | Prompt block and trigger directive; prompt/message selection; sender targeting; `resolveTaskAuthority` |
| `features/tasks/server/matcher.test.ts` | Match prompt (audience prefix, sender line, two-step structure) and every fail-closed citation path |
| `features/tasks/server/live-matcher.integration.test.ts` | `LLM_LIVE=1`: a real classifier fires a person-only task for its person and nobody else, and a content condition still binds |
| `features/tasks/server/fire.test.ts` | The delivery inversion: `deliver` binding, quiet fires, delivery-failure semantics, history mirroring |
| `features/tasks/server/tasks.integration.test.ts` | Scopes, caps, duplicates, targeting, per-kind timing and gates, chat-side idempotence, traces |
| `features/tasks/server/scheduler.integration.test.ts` | The due-run loop: settle per kind, quiet fires, one-shot retry/disable |
| `features/mcp-tools/server/service.test.ts` | The outbound carve-out: reply turns never see `send_message`; fires do |
| `features/bot-messaging/server/service.test.ts` | The task-opened turn: directive placement, enforcement retry + suppression, the addressed-turn authority pass |
