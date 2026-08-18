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
- **Timed kinds** are the old scheduled tasks: uncapped (they cost nothing until
  they fire) but **deduplicated on wording *and* timing**, chat-bound (a fire
  needs somewhere to speak), carry an optional `context` gathered at creation
  (a fire sees no transcript), and keep the one-shot retry lifecycle — a failed
  due one-shot retries on later ticks up to **5 attempts**, then is disabled,
  never deleted (and a disabled task is gone as far as the chat is concerned —
  see below); a fired one-shot is deleted, spent.

## How a task delivers — no hardcoded sending

A **task-driven turn** sends nothing it merely writes. Its completion text is
traced, and a message reaches the chat only through a delivery tool (user
decision, 2026-08-13). Which tool depends on what started the turn (user
decision, 2026-08-14):

| Turn | Delivery tool | Why |
| --- | --- | --- |
| Ordinary reply (someone addressed the bot) | none | Its own answer *is* the message; a send tool would double-send |
| `message` task opened the turn | `reply_to_message` | It is acting on a message somebody posted, so the answer belongs under it |
| Timed fire | `send_message` | Nothing triggered it, so there is nothing to reply to |

Both tools take **`text` and nothing else**. Where the message lands is the
runtime's decision, not the model's: `reply_to_message` attaches to the message
that triggered the task, `send_message` sends standalone. The model never names
a target, so it can never aim one wrong.

That shape replaced a `reply_to_message` that took a `message_id` plus an
optional `text`, and retargeted in a reply turn while delivering in a fire. The
dual mode cost a live outage: pushed by the enforcement directive to "call the
tool the rule requires", the model put its whole answer into the `text` of a
retarget call, the reply path discarded it, and the turn died with nothing to
send (trace `224ef60a…`, 2026-08-14). A parameter silently ignored in one of two
modes is a trap.

The turn binds `deliver` and `deliveryKind` on the MCP tool context
(`server/mcp/context.ts`), and `getToolset({ delivery })` offers at most one of
the two. The handlers check the binding's **kind**, not merely its presence, so a
registry that survived a hot reload cannot let a fire claim it replied to a
message that never existed.

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
   vision, the browse-ack flow — but **not** the delivery: it is offered
   `reply_to_message`, and that call is what speaks. Its own completion text is
   never sent.

   A task-opened turn that calls no tool is retried once with
   `TASK_ENFORCEMENT_DIRECTIVE`, then suppressed with an honest system notice,
   and the trace fails. That guard is only sound because the turn now *has* a
   tool for saying something. Before, a task whose action was conversational —
   *"from time to time, comment on a message"* — had nothing it could honestly
   call, so its correct answer was suppressed and the chat got a "could not
   carry out" notice instead (trace `d1c01591…`, 2026-08-14).

   Calling a tool other than the delivery one is fine and settles the turn
   quietly: a rule whose action was "download the file" is carried out by the
   download and owes the chat nothing further.

   What a task-opened turn delivers is stamped onto each opening task's capped
   `recent_deliveries` (`recordTaskDeliveries`, best-effort), and the trigger
   directive feeds a task's recent deliveries back as the shared
   `WORDING REFERENCE ONLY` block (`buildRecentDeliveriesBlock`) — the same
   anti-repetition loop timed fires have. Without it a recurring conversational
   rule converged on one phrasing every run (user report, 2026-08-16): the
   model saw the same instruction over the same shape of input with no memory
   of what it had already said for it.

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
| Pausing | The `enabled` toggle | **Not offered** — cancelling is deleting |

Chat-side gates are enforced **inside the service** (no lexical pre-filter),
and a denial is returned, never thrown, so the model relays the refusal:

- **Prompt kinds** keep the rules gate (user decision, 2026-07-29): self-serve
  in a private chat, owner-only in a group.
- **Timed kinds** keep the scheduled-tasks gate: anyone in the chat may create;
  a task is changed or cancelled by its creator, or by the owner (exemption:
  user decision, 2026-08-07), judged on the turn's *authority*.

A task of another chat is invisible (`not_found`); a global task is visible but
read-only from chat.

## Creating the same task twice

Creating from chat is **idempotent**: the same task again returns the one
already in force, unchanged (trace `f33e1ede…`, 2026-07-29 — a tool that
punishes a repeat teaches the model to reassure in prose instead of calling),
while a standing task asked for with a *different audience* amends the audience
and says so. The dashboard gets a 409 for the same cases — an operator must see
a no-op for what it is.

What makes two tasks one task differs by family (`findDuplicateTask`):

| Family | Identical when | Because |
| --- | --- | --- |
| Prompt | The **wording** matches, whichever prompt kind carries it | The text is the rule; twice in one prompt is noise |
| Timed | The wording **and** the trigger with its timing match | "Remind me at 9" and "at 18:00" are two jobs; the same words at the same time is one job asked for twice |

Timed dedup replaced an exemption ("two reminders, not noise") after it cost a
live pair of identical reminders three seconds apart (user decision, 2026-08-14
— trace `796852a6…`). The timing is compared **normalized**, so `9:00` and
`09:00` are the one schedule they are. Only tasks in force are compared: a
paused row blocks nothing (see below), and an edit is checked the same way
against its edited shape — except when it is being paused, which duplicates
nothing and is how an operator resolves a pair that predates the rule.

The root cause of that trace was not the tasks feature: the model answered *and*
called `tasks_create` in one round, the next round came back empty, and the tool
loop's retry notice told it nothing had run — so it made the same call again.
The loop no longer says that; see `docs/architecture/llm-and-mcp.md`.

## Paused tasks belong to the operator

A paused task is invisible to the bot — not composed into a prompt, not offered
to the matcher, not fired, and not listed, read, changed or deleted through the
chat toolkit (`isVisibleFromChat`, read through `getChatVisibleTasks` /
`getChatVisibleTask`; user decision, 2026-08-14). From a chat it reads as an
unknown id, which is what it is to the people there.

It leaked before: `tasks_list` returned paused rows, and the model — holding a
rule it could neither carry out nor remove — told the group about a task it was
supposedly still under and could not delete. A rule the bot cannot act on has
nothing to say to anyone.

The same decision removes pausing from the chat side entirely: **cancelling a
task from a chat deletes it**, and `enabled` exists only on the dashboard's
toggle and its `PATCH /api/tasks/[id]`. Two consequences follow:

- `updateTaskFromChat` refuses a patch carrying `enabled` (the tool schema
  cannot express one; the refusal covers every other caller of the service).
- The prompt-task duplicate guard skips paused rows, so the same wording can be
  set again. The guard is a prompt budget, and a paused task is in no prompt —
  while answering "already in force" about a switched-off rule would be a lie,
  and refusing with a reason would tell the chat about a task it is never shown.

## Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `tasks_list` | — | This chat's tasks with ids, triggers, and audience, plus the global ones |
| `tasks_get` | `id` | One task, including its saved context |
| `tasks_create` | `instruction`, `trigger`, `context`, `user_ids`, `every_minutes`, `delay_minutes`, `time`, `weekdays`, `date` | Save a standing rule or a timed job |
| `tasks_update` | `id` + any of the above, `applies_to_everyone` | Reword, retime, retarget |
| `tasks_delete` | `id` | Remove a task for good — how a chat cancels one |
| `send_message` | `text` | **Timed fires only** — send a standalone message to the task's chat |
| `reply_to_message` | `text` | **`message`-triggered turns only** — reply to the message that triggered the task (bot-messaging) |
| `set_message_reaction` | `message_id`, `emoji`, `big` | React to an earlier message (bot-messaging; every turn — a reaction is not a delivery) |

`tasks_create`'s description is long by design and pinned in tests: it carries
every behavioural rule its two predecessors earned in production — the many
phrasings of a rule and of a schedule request, memory-tool disambiguation,
trigger selection ("in 5 minutes" is `timeout` with `delay_minutes` 5, "every
10 minutes" is `interval`), gather-context-before-creating for timed kinds
(2026-07-28: a fire sees no transcript), repeat-is-safe idempotence
(`f33e1ede…`), roster-copied `user_ids` (never derived from a name), and the
one-time-vs-weekly rule (2026-08-18: "remind me tomorrow at 9" was saved as
`weekdays: [Tue]` — every Tuesday forever — instead of `date`; the description
and both param descriptions now spell out that a one-time request resolves to
`date` and `weekdays` is only for every-week requests, and that relative time
words like "tomorrow" must stay out of the instruction, whose text is read only
when the task fires).
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
(skipped, not dropped). Each fire composes the chat's specialist, language, the
standing-tasks block (null sender), and the chat identity context — the group
roster (names, @usernames, user ids) or the DM partner — and runs with the
task's chat bound as the tool context. The identity context is what lets a fire
address its target by their exact `@username`: a bare name or alias notifies
nobody on Telegram (operator report, 2026-08-18 — a reminder greeted its target
by a nickname and was never seen), so the fire directive requires an @username
mention for person-directed messages, falling back to the name only when none
is listed. Job card on `/tasks` and `/jobs`; "Run due now" via
`POST /api/tasks/run`.

**Manual fire.** Every timed task's card has a "Fire now" button
(`POST /api/tasks/{id}/fire` → `manualFireTask`): the exact fire path — same
prompt composition, tool context, delivery, and history mirror — run
immediately on the operator's request, but deliberately **off the schedule's
books** (user decision, 2026-08-18: a manual fire does not count as a regular
one). `next_run_at`, `last_run_at`, `attempts` and `recent_deliveries` stay
untouched and a one-shot is not consumed; a failed manual run does not spend
the retry budget either. Traced as `tasks`/`manual-fire` with the `dashboard`
trigger (still correlated to the task id, so it joins the task's flow).
Maintenance mode does not block it — it is an explicit operator action, not a
background push — and prompt kinds are refused (they have no fire to run).

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

Every mutation is traced under `tasks` (`create`/`update`/`delete`), every
scheduled fire as `tasks`/`fire`, and every dashboard "Fire now" as
`tasks`/`manual-fire` (both with usage `callKind: "task-fire"`), with the task id in
`relatedIds.tasks` and, when a fire delivered, the `<chatId>:<messageId>`
correlation so feedback can find it. A fire relates its task id **at open**
(`trace.relate`), so failed and quiet fires stay findable, not only delivered
ones. The match decision is recorded on the reply trace of the message it
judged (`callKind: "task-match"`, a `task match` step with the offered tasks,
matches, and the bound `authorityUserId`); when tasks *match*, their ids are
related on that reply trace too, so a standing task's actual runs are part of
its record. Tool calls are traced under `mcp-tools-tasks`.

A chat-side mutation stamps the **turn's** correlation
(`toolContextTrigger`, 2026-08-18 — it used to stamp the bare chat id, cutting
the create out of the turn that asked for it), so `/debug?flow=<any linked id>`
walks the whole story: the reply turn that created the task, its tool calls,
every fire, and what each fire sent. See the Flow section of
`docs/architecture/observability.md`.

Each task card on `/tasks` has a Debug button linking to
`/debug?relatedId=<taskId>` — every trace about that one task (fires, matched
replies, the create/update/delete audit trail) in one list. The `relatedId`
facet is a first-class Debug filter; see
`docs/architecture/observability.md`.

## Tests

| File | Covers |
| --- | --- |
| `features/tasks/schedule.test.ts` | Trigger math: wall-clock conversion, per-kind next-run, normalization, summaries |
| `features/tasks/format.test.ts` | Prompt block and trigger directive; prompt/message selection; sender targeting; `resolveTaskAuthority` |
| `features/tasks/server/matcher.test.ts` | Match prompt (audience prefix, sender line, two-step structure) and every fail-closed citation path |
| `features/tasks/server/live-matcher.integration.test.ts` | `LLM_LIVE=1`: a real classifier fires a person-only task for its person and nobody else, and a content condition still binds |
| `features/tasks/server/fire.test.ts` | The delivery inversion: `deliver` binding, quiet fires, delivery-failure semantics, history mirroring |
| `features/tasks/server/tasks.integration.test.ts` | Scopes, caps, per-family duplicates (wording, and timing for timed kinds), targeting, per-kind timing and gates, chat-side idempotence, paused-task invisibility, traces |
| `features/tasks/server/mcp-tools.test.ts` | The toolkit boundary: reads go through the chat-visible service, an invisible id reads as unknown, and no tool can pause anything |
| `features/tasks/server/scheduler.integration.test.ts` | The due-run loop: settle per kind, quiet fires, one-shot retry/disable |
| `features/mcp-tools/server/service.test.ts` | The delivery carve-out: an ordinary reply turn sees neither tool, a `message` turn sees only `reply_to_message`, a fire only `send_message`, and never both |
| `features/bot-messaging/server/service.test.ts` | The task-opened turn: directive placement, enforcement retry + suppression, the addressed-turn authority pass |
