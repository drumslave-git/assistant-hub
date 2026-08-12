# Scheduled tasks

**Feature ids:** `scheduled-tasks`, `mcp-tools-scheduled-tasks` ·
**Dashboard:** `/scheduled-tasks` · **SSE topic:** `tasks` · **Priority 9**

Reminders and nudges the bot delivers at a wall-clock time, created either from the
dashboard or conversationally in chat ("remind me in 5 minutes", "every weekday at
9").

## What a task is

An **instruction**, not a canned message. When a task fires, the bot composes an
out-of-band prompt — base system prompt + active persona + the task directive — and
has the LLM write an in-character chat message that *performs* the directive. Then it
delivers it, mirrors it into history, and records the whole pass as a trace.

That is why `recent_deliveries` exists: the last five delivered texts are kept and
passed back in, so a daily reminder does not arrive word-for-word identical every
day. They are quoted to the fire as a **wording reference only, explicitly not a
source of facts** — they are the bot's own past output, so one hallucinated fire
would otherwise seed the next and compound from there (user report, 2026-08-01).
Same source ranking the reply path applies to the bot's own transcript lines.

## Saved context

A fire sees **no transcript**: the stored `instruction` and `context` texts are its
whole world. So an instruction that points at something ("remind Kyrylo who X is")
delivers the pointer, not the reminder — observed in production, 2026-07-28.

`context` (nullable, ≤4000 chars) is the background gathered when the task was set
up, written self-contained for a reader with no chat transcript. `tasks_create`
takes it as a **required** input; `tasks_update` takes it as an optional
replacement, and its description carries the same gather-first rule, since the case
that most needs it is a user supplying the background a thin existing task was
missing (2026-08-01). `tasks_list` flags a task that has none, and `tasks_get`
prints it, so the model can tell what a task is actually carrying.

The fire's history lookup stays as the second line of defence for tasks created
before the column existed; those are deliberately not backfilled.

## Schedules

| Kind | Needs | Fires |
| --- | --- | --- |
| `once` | `runDate` (`YYYY-MM-DD`) + `timeOfDay` | Once, then the task is deleted |
| `daily` | `timeOfDay` | Every day |
| `weekly` | `weekdays` (0 = Sunday) + `timeOfDay` | On the given weekdays |

All times are local wall-clock times in the **operator timezone**
(`settings.timezone`). `features/scheduled-tasks/schedule.ts` converts between a
zone's wall-clock components and absolute UTC instants using `Intl` alone — no
timezone library — and is pure and client-safe, so the dashboard describes and
previews a schedule with the exact same code the server schedules against. It is
grounded in the MVP's `features/tasks/schedule.ts`, the best-shaped MVP code, reused
nearly verbatim.

Field *shapes* are validated by the zod schema; schedule **coherence** (a `once` task
needs a date, a `weekly` task needs weekdays) is enforced by `normalizeSchedule` in
the service, which also computes `next_run_at`.

## The poller

A fixed-interval scheduler ticking every **30 seconds** — not the idle-debounced
kind, because a task must fire at its wall-clock instant regardless of whether the
bot is busy.

Each tick, under a cross-process advisory lock:

1. Scan for due tasks (`enabled = true AND next_run_at <= now`, served by
   `scheduled_tasks_due_idx`).
2. Fire each one.
3. Advance `next_run_at` — or delete the task outright once it is spent (a one-shot
   that has fired).

The LLM connection is read fresh per tick.

**Firing is paused while maintenance mode is on.** Due tasks stay due — they are
skipped, not advanced — so they deliver once maintenance ends. This is surfaced
explicitly: the job card's `paused` notice exists because the page previously showed a
green "Enabled" badge and a next-run time while the message silently never arrived.

A due one-shot that keeps failing is capped at 5 attempts
(`MAX_ONE_SHOT_ATTEMPTS`).

## Chat tools

Five MCP tools under `mcp-tools-scheduled-tasks`. The chat is bound per turn, so every
tool operates only on the **current** chat's tasks — the model never passes (or picks)
a chat id.

| Tool | Scope |
| --- | --- |
| `tasks_create` | Anyone in the chat |
| `tasks_list`, `tasks_get` | Read all of the chat's tasks, with their author |
| `tasks_update`, `tasks_delete` | **Author only** — you cannot change or cancel someone else's task |

Per the recorded decision these are **not owner-gated** (unlike the MVP, which
restricted tasks to the owner). Authorship (`created_by_user_id`) is what limits
mutation; listing shows everything so the model can see what exists.

### When the id does not match

`tasks_update`, `tasks_delete` and `tasks_get` answer an id that matches nothing in
this chat with **which case it is**: whether the id is malformed (not a UUID —
truncated or mistyped while copying) or simply unknown here, plus the chat's actual
task ids to copy from. The old answer was one sentence for all three cases, and a
model that dropped a character out of an id it had just listed concluded the task
had vanished, said "done", and left it scheduled (2026-08-05). Ids are matched
exactly — nothing is resolved by similarity, least of all for a delete.

`tasks_create`'s description tells the model to resolve any relative or named time
("in 5 minutes", "tonight", "tomorrow at 9") against the current date/time given in
context, then pass a concrete time. That context is the `time context` system line the
reply pipeline injects — without it the model cannot resolve a relative time at all.

## Data

`scheduled_tasks` — see [Data model](../architecture/data-model.md#scheduled_tasks).
Key columns: `instruction`, `context`, `schedule_kind`, `time_of_day`, `weekdays`, `run_date`,
`enabled`, `attempts`, `recent_deliveries`, `last_run_at`, `next_run_at`,
`created_by_user_id`.

## Dashboard

`/scheduled-tasks`: create, edit, enable/disable and delete tasks, plus "run due now".
The target-chat picker resolves known DMs and groups. Times render in the operator
timezone via the shared `<Timestamp>`. The list is kept fresh live on the `tasks`
topic in addition to `router.refresh()` after each mutation.

## API

`GET|POST /api/scheduled-tasks`, `PATCH|DELETE /api/scheduled-tasks/{id}`,
`GET|POST /api/scheduled-tasks/run` (the poller's status / one immediate tick).

Note that a dashboard-created task has `createdByUserId: null` — the operator is not a
Telegram user — which means the author-scoped chat tools cannot mutate it. The owner is
the exception: exempt from the author rule, they can cancel or edit any task in a chat
they are in, authorless ones included (user decision, 2026-08-07).

## Configuration

| Setting | Effect |
| --- | --- |
| Chat backend + `model` | A tick with no LLM configured is a harmless no-op |
| `timezone` | The zone every `timeOfDay` and `runDate` is interpreted in |
| `maintenanceModeEnabled` | Pauses every fire |

## Tracing

Feature `scheduled-tasks`. Every mutation (create, update, delete) is traced; reads
are cheap and untraced. Each **fire** is its own trace covering the composed prompt,
the completion, and the delivery.

## Tests

Unit: `schedule.test.ts` (the wall-clock math), `server/fire.test.ts` (injected
collaborators — no LLM, no Telegram), `server/mcp-tools.test.ts`.
Integration: `server/scheduled-tasks.integration.test.ts`,
`server/scheduler.integration.test.ts`,
`server/tool-selection.integration.test.ts`.
