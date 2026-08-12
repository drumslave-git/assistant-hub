# Analytics

**Feature ids:** `analytics`, `analytics-insights` · **Dashboard:** `/analytics` ·
**SSE topic:** `analytics` · **Priority 11** (inserted ahead of image generation by
the user, 2026-07-15)

What the bot has been doing: traffic, token spend, model performance, active people,
and an LLM-derived read on the conversation itself (mood, word of the period, top
topic).

## Two data sources, no mirror

| Source | Feeds |
| --- | --- |
| `chat_messages` (live SQL) | Message volume, active/new users, top users |
| The **trace files** (`server/trace/store.ts`) | Tokens, model performance, traffic tiles |
| `chat_hour_insights` / `period_insights` | Mood, word of the period, top topic |

Tokens and model performance read the **real traces**, not a compact Postgres mirror
written at settle time. That mirror existed and is gone: it was a second source of
truth for the same events, could only carry what its writer thought to distil, and
distilled away exactly the detail Model performance needs.

The trace reader's shape is deliberately **scan once → flatten to rows → aggregate**
(`server/trace-source.ts`): the service fetches the period's traces once and passes
them to pure aggregators, so one metrics request costs one store scan no matter how
many readings it takes, and every caller filters and buckets the same flat row type.

## Periods, not trailing windows

The filter is **one selected period** — `day 2026-07-18` means that day,
00:00–24:00 on the operator's wall clock — and you step to the next or previous one.

`features/analytics/period.ts` owns the whole contract (pure, dependency-free via
`Intl`):

| Function | Produces |
| --- | --- |
| `periodRange(unit, anchor)` | The **half-open** UTC instant range `[startUtc, endUtc)` every query filters on |
| `subBucketKeys(unit, anchor)` | The dense chart axis *inside* the period — a day is 24 hours, a year is 12 months |
| `stepAnchor` / `currentAnchor` | Period navigation |

Two details that were bugs before:

- **Half-open is the point.** The previous shape had a lower bound only, so "day" and
  "week" both swallowed all recent history and reported identical totals.
- **The dense axis** is what makes every period draw a real line instead of one dot.

The **exact same** bucket-key format is produced here in JS (to build the gap-free
axis) and by Postgres `to_char(date_trunc(...))` in the repository (to group the
values). The two must agree, which the unit tests pin. Weeks are ISO weeks (Monday
start), matching `date_trunc('week', …)`; a week's key is its Monday's date.

Period anchors are resolved **server-side** from the operator timezone and passed
down. The browser's clock must not decide what "today" means on a dashboard
describing a bot that lives somewhere else.

## Per-card filters

There is **no page-level filter**. Every card carries its own period and chat/user
scope and fetches itself, so you can hold last Tuesday's mood next to this month's
token trend. The page Server Component supplies only what is shared: the filter option
lists and the current period per unit.

`FilterableCard` owns that whole contract in one place — the controls, the per-card
state, the loading and error affordances, and a header layout that stays readable with
several controls in it. A card supplies its title, which filters it honours, and how to
render its data.

Which filters a card gets is deliberate: a control that changes nothing is worse than
no control, because it makes the reader believe they have sliced the data when they
have not. So `chats`/`users` are **omitted** by cards those dimensions are meaningless
for rather than rendered inert — "new users" is a global fact about a person's first
sighting, so the Users card takes neither.

The **PeriodPicker** replaced a "last 30 days / last 26 weeks" selector that had two
problems this fixes: the label never matched the window (choosing "Day" showed a
month), and there was no way to look at any period but the most recent. A calendar
jumps anywhere, with the periods that actually hold data **marked** — answered by
`GET /api/analytics/availability` from the calling card's own source, so the calendar
never offers a date the card would then render empty.

## The cards

| Card | Source | Filters | Endpoint |
| --- | --- | --- | --- |
| Traffic (tiles: handled, replied, failed, tokens processed/generated, active users, images) | traces + messages | period, chat, user | `/api/analytics/metrics` |
| Mood / Word of the period / Top topic | insights | period, chat | `/api/analytics/insights` |
| Message volume | messages | period, chat, user | `/api/analytics/series?section=volume` |
| Tokens (processed vs generated) | traces | period, chat, user | `…&section=tokens` |
| Users (active and newly-seen) | messages | period only | `…&section=users` |
| Mood trend | insights | period, chat (**required**) | `…&section=mood` |
| Model performance | traces | period | `/api/analytics/models` |
| Top users | messages + traces | period, chat | `/api/analytics/top-users` |
| Insight job card | — | — | `/api/analytics/insights/run` |
| Regenerate card | — | granularity + bucket | `/api/analytics/insights/regenerate` |

Model performance groups every recorded LLM round by model **and** by
[call kind](../architecture/llm-and-mcp.md#call-kinds), ordered so the biggest
consumer of wall time comes first, and reports calls, mean/p50/p95 latency, prompt and
completion tokens, and tokens per second. The call-kind axis exists because one handled
message is a single trace containing an addressing check, several tool rounds and a
final answer — three kinds of work with completely different cost profiles, previously
averaged into one number that moved with the mix rather than with any actual request.

## Charts

One ECharts wrapper (`ui/Chart.tsx`), a Client Component that
lazy-`import("echarts")` on mount so the ~1 MB library never enters the server bundle.
Its callers pull it in via `next/dynamic({ ssr: false })`.

Theming is explicit, not automatic: the caller builds its `option` from the supplied
`ChartTheme` — the data-viz skill's validated per-mode steps, where the dark theme is
its own selected palette rather than a flipped light one. The chart re-renders without
re-init when the option or theme changes, and follows the dashboard's light/dark toggle
live.

## The insight job

Daily at `settings.daily_jobs_run_time`. It scores each finished chat-**hour**'s mood,
top topic and word with **one** LLM call, then rolls those hour rows up the calendar:
hour → day → week/month → year → all time, for every period a scored hour touches.

That is what makes mood, word of the period and top topic available at whatever period
the dashboard is pointed at — and, because the hour is the finest thing the dashboard
plots, what lets a day's mood curve exist at all.

**Roll-ups are hierarchical, not flat.** A month is rolled up from its ~31 *days*, not
its ~700 hours. Each level reads only its immediate children, so every call sees at
most 31 entries regardless of how much history exists.

**Mood is deterministic.** At every level it is a message-weighted mean, so it never
depends on a fragile parse — and because a child's mood is already the weighted mean of
*its* children, rolling up levels gives exactly the same number as averaging the
underlying hours directly. Only the word and topic are an LLM pass, and that pass
*selects* among the children rather than writing new text.

**Work is only ever added by an unscored hour.** A scored hour is final: the job never
re-reads it because its message count drifted, and never reconciles stored roll-ups
against what it thinks they should be. Both of those were self-healing scans, and both
made the nightly token spend a function of invisible state.

Fails **closed** per unit: an unusable model response leaves the stored row untouched
and the hour stays owed for the next run.

### The scan floor

The due-scan asks "which (chat, hour) pairs have messages but no stored insight?" —
naively answered by re-grouping the entire mirror through a computed timezone
expression on every nightly run *and* every jobs-dashboard read.

But new owed hours only ever appear near the present, so a process-local watermark
holds a proven floor. Two exceptions, both handled explicitly:

- Telegram can deliver a backlogged update up to ~24 hours old, landing a fresh row in
  an old hour — so the floor never advances closer than a safety margin behind "now".
- A history CSV import writes, and a regenerate un-scores, arbitrarily old hours. Both
  call `resetInsightScanFloor()`, so the next scan is unbounded and sees them.

The floor is deliberately process-local (a `globalThis` slot): a boot starts cold with
one unbounded scan — exactly the pre-floor behavior — and the app runs as a single
process, so there is no second process whose scans could advance past work this one
created.

### Regenerate

The deliberate replacement for that removed reconciliation. The operator names a
granularity and bucket; every **day score covering that period** is deleted along with
every roll-up built from it, which re-arms them through the ordinary unscored-hour
path.

It is **destructive and billable** — each dropped day costs one LLM pass to re-score —
so the button confirms before it fires and says exactly what it is about to throw away.

## Data

`chat_hour_insights` (unique on `(chat_id, insight_hour)`) and `period_insights`
(unique on `(granularity, bucket, chat_id)`). Nothing else — the numeric metrics have
no stored table.

## Configuration

| Setting | Effect |
| --- | --- |
| Chat backend + `model` | A run with no LLM configured is a harmless no-op; the numeric charts still work |
| `timezone` | Every period boundary and bucket key |
| `dailyJobsRunTime` | When the job runs |

## Tracing

| Feature id | Covers |
| --- | --- |
| `analytics` | The feature's own operations |
| `analytics-insights` | The scoring and roll-up runs (`relatedIdsKey`: `chat_day_insights`) |

## Tests

Unit: `period.test.ts` (the bucket math, including the JS↔Postgres key agreement),
`mood.test.ts`, `llm-call-kind.test.ts`, `server/prompt.test.ts` (the fail-closed
parsers).
Integration: `server/analytics.integration.test.ts`.
