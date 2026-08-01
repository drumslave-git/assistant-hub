# Background jobs

Background work runs **in-process**, on shared scheduler primitives, guarded by
Postgres advisory locks. There is no external cron, no separate worker service
and no on-demand-only work. That is the recorded operating model for this app: a
single self-hosted container already runs in-process singletons (the Telegram
poller, the MCP registry, Chromium, the realtime hub), and jobs run the same way.

## The three primitives

All three live in `server/jobs/` and are deliberately **job-agnostic**: they own
the timer and the phase machine only. Locking, persistence and tracing belong to
the job body.

### Idle-debounced — `idle-scheduler.ts`

Runs a job only after the system has been quiet for a debounce interval.
`onActivity()` is called on every unit of live work (a handled Telegram message),
which re-arms the wait **and aborts any batch currently running**. Backfill-style
work therefore never competes with a live reply for the LLM.

Status shape (`IdleJobStatus`): `phase` (`idle` | `scheduled` | `running`),
`lastRunAt`, `lastSummary`, `lastError`, `nextRunAt`, `progress`.

Used by: vision backfill.

### Fixed-interval — `interval-scheduler.ts`

A plain ticker with an overlap guard (a slow tick is never re-entered). For work
that must happen at a wall-clock instant regardless of activity. The timer is
`unref`'d so it never keeps the process alive on its own.

Status shape (`IntervalJobStatus`): `running`, `ticking`, `lastTickAt`,
`lastSummary`, `lastError`, `progress`.

Used directly by: the scheduled-tasks poller.

### Daily — `daily-scheduler.ts`

Built on the interval ticker. Every minute it asks: *has today's configured local
run time passed, and have we not run since it?* That question is the whole
contract, and it buys two properties:

- **Idempotent across restarts** — a process that comes back up after the hour
  still runs the day's job once.
- **Immune to drift** — no accumulating "every 24h" error.

The run time is a single shared setting (`settings.daily_jobs_run_time`, default
`04:00`, read in the operator timezone), so all daily jobs run in the same window.
The due math is pure (`daily-due.ts`) and unit-tested.

Info shape (`DailyJobInfoBase`): `status`, `nextRunAt`, `runTime`, `timezone`,
`lastResult`. Each feature extends it with its own backlog fields.

This primitive exists because the daily schedulers each used to carry a
private copy of the same ~100-line shape. A feature now supplies only its
`runJob` and the extra info fields its card shows.

## The seven jobs

| Job | Primitive | Runs | Work | Backlog badge |
| --- | --- | --- | --- | --- |
| **Vision backfill** | Idle | After the bot has been quiet | Caption `message_media` rows still `pending` | Media pending |
| **Task poller** | Interval | Every tick | Fire due scheduled tasks, advance `next_run_at`, delete spent one-shots | Overdue tasks |
| **History summary** | Daily | `daily_jobs_run_time` | Compress each finished chat-day into embedded topic summaries | Chat-days |
| **Memory** | Daily | `daily_jobs_run_time` | Two ordered passes: passive extraction, then consolidation | Chat-days to read + notes to fold |
| **Analytics insights** | Daily | `daily_jobs_run_time` | Score finished chat-hours, roll up the calendar | Chat-hours |
| **Self-improvement** | Daily | `daily_jobs_run_time` | Distill feedback into new preference and correction versions | — |
| **yt-dlp updater** | Daily | `daily_jobs_run_time` (plus once at boot) | Install a newer yt-dlp from upstream into `data/bin` | — |

The **browser-agent runner** is an eighth piece of background machinery but not a
scheduler: it is a queue pump over the `browser_agent_runs` table, woken by an
enqueue signal rather than a clock. At boot it sweeps any run left `running` by a
previous process to `failed`.

Every job settles as a **harmless no-op** when there is nothing to do or no LLM is
configured. None of them throw into the scheduler.

The yt-dlp updater is the odd one out: it needs neither an LLM nor the database,
and it is the only job that exists to prevent a *silent* failure rather than to
produce anything. A stale yt-dlp does not warn — it just answers every media page
with an extraction error. See
[Browser agent](../features/browser-agent.md#keeping-yt-dlp-current).

### Why the expensive jobs run at night

History summarization, memory and analytics insights each cost one or more LLM
passes per chat-day. Nothing *live* depends on them: the last 24 hours are already
injected into every reply verbatim, and the numeric analytics charts are computed
live from the base tables. Only mood/word/topic and long-term recall wait for the
night's run.

### Idempotency, per job

Each job owns its own idempotency, and each one is a different mechanism:

| Job | What makes a re-run cheap |
| --- | --- |
| Vision backfill | Per-row `status = 'pending'` gating; `describeAndStore` re-checks status before spending a call |
| History summary | `chat_summary_days` records the message count at processing time — an unchanged day is skipped |
| Memory extraction | `memory_extraction_days`, the same way |
| Memory consolidation | A consumed note is deleted, so it is never re-spent |
| Analytics insights | A scored hour is **final**. The job never re-reads it because the message count drifted |
| Self-improvement | An empty backlog is a no-op; incorporated rows carry the version that consumed them |
| Scheduled tasks | Only tasks whose instant has actually passed fire |
| yt-dlp updater | A version compare short-circuits before anything is downloaded |

Analytics deserves the emphasis. Earlier versions reconciled stored roll-ups
against what the job thought they should be, which made the nightly token spend a
function of invisible state and could rewrite a score nobody asked it to touch.
Correcting a score is now an explicit operator action — the Regenerate card, which
drops rows and re-arms them through the ordinary unscored-hour path.

## Advisory locks

`server/jobs/lock.ts` wraps Postgres **session-level advisory locks**. The
in-process scheduler already guarantees one run at a time within a process; the
lock additionally guards *cross-process* overlap — two server instances briefly
co-existing during a redeploy.

A session-level lock lives on the connection that took it, so acquire, hold and
release must all happen on one pinned connection. The helper pins a dedicated pool
client for the lock's lifetime; the job body is free to use the shared pool for
its own queries, because the lock is global across the database rather than scoped
to the connections reading rows.

A lock miss is a **benign skip**, not a failure — idempotency is the job's own
concern, so the other process's run covers the work.

The yt-dlp updater takes **no** lock. The locks above coordinate processes sharing
one database; that job writes a file inside its own container, so a second instance
would have its own `data/bin` and nothing to contend over.

## Live progress

`server/jobs/progress.ts` is a pure type module: the schedulers hold a
`JobProgress | null` for the duration of a run and clear it when the run settles.
A job body reports into it via its run context.

The Jobs board renders it as a determinate bar with an `n / total` count when the
work is a countable loop, and an indeterminate spinner plus the current step when
the length is not known up front — never a misleading bar.

## The Jobs board

`/jobs` is the consolidated view. `features/jobs/server/registry.ts` is the one
place that knows all seven jobs: it calls each feature's `getXJobInfo` getter and
normalizes the two different status shapes (idle vs interval, plus each job's own
backlog and pause state) into a single `JobView` the board renders uniformly.
That coupling deliberately mirrors `register-node.ts`, which is likewise the
single place that *starts* all seven.

Each card shows: an activity badge, next/last run, the last result, the backlog,
a live progress bar while running, a "Run now" button hitting the owning
feature's endpoint, and a **notice** — the reason the job is currently *not*
doing its work.

That last field matters more than it looks. A job that silently declines to run
(paused by maintenance mode, no LLM configured, nothing to do) is the failure mode
an operator cannot diagnose from a dashboard that only ever shows "Enabled".

The board subscribes to all six job topics at once over the shared SSE stream, so
any status or progress change refreshes it with no manual reload.

## "Run now" semantics

`POST` to the job's run endpoint. Two flavours:

| Flavour | Endpoints | Behavior |
| --- | --- | --- |
| Awaited | `/api/analytics/insights/run`, `/api/scheduled-tasks/run`, `/api/vision/backfill` | Triggers the run (or forces the next tick) and returns the refreshed job info |
| Fire-and-forget | `/api/history/summaries/run`, `/api/memory/run`, `/api/self-improvement/run`, `/api/browser/ytdlp/run` | Returns the job snapshot **immediately** and progress arrives live over SSE, because a backlog can take many LLM passes (or, for yt-dlp, a ~40 MB download) |

Forcing a run does not skip the job's own gating: an unchanged day is still
skipped, a scored hour is still final, and maintenance mode still pauses task
fires.

## Adding a job

1. Pick the primitive: idle (defer while busy), interval (must hit a wall-clock
   instant), or daily (once a day at the shared run time).
2. Write the job body. It owns its advisory lock, its persistence, its
   idempotency gating and its trace.
3. Wrap the scheduler in a `globalThis` singleton so there is exactly one per
   process and it survives hot reload.
4. Export `startX` / `stopX` / `runXNow` / `getXJobInfo`.
5. Register start and stop in `server/telegram/register-node.ts`.
6. Add a mapper in `features/jobs/server/registry.ts` (the mappers are pure and
   exported so the normalization is unit-testable without mocking every scheduler
   module).
7. Add a `Run now` route, and a feature job card built on the shared
   `JobStatusCard`.
