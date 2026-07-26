# Operator guide

Every dashboard page, what it shows, and what you can do on it.

Two things are true of every page and worth stating once:

- **Data is live.** Pages update themselves over the shared SSE stream. If a page
  looks stale, that is a bug — not something to fix with a reload. The `LiveIndicator`
  pill shows the connection and can be clicked to pause refreshes while you read.
- **Times are in the operator timezone** (Settings → Timezone), never your browser's
  local zone and never bare UTC.

## Layout

A fixed sidebar on desktop, an off-canvas drawer on mobile, and a sticky top bar with
a search field, the theme toggle and **Sign out**. Above every page sits the global
system-alert area — reserved for failures that silently destroy data if nobody acts.
Today there is exactly one: the trace write path. If that banner appears, read
[Troubleshooting](troubleshooting.md#trace-flush-failures) before doing anything else.

Navigation, in sidebar order:

| Group | Pages |
| --- | --- |
| — | Overview, Analytics |
| Conversations | History, Vision, Users, Groups |
| Bot | Personalities, Memory, Tools, Self-improvement |
| Automation | Scheduled tasks, Browser agent, Background jobs |
| System | Settings, Debug |

---

## Overview (`/`)

The honest-state page. Everything on it is a **real probe** performed at request
time, never an "is the variable set" guess:

| Card | Probe |
| --- | --- |
| Database | An actual `SELECT 1` |
| LLM endpoint | An actual `/v1/models` call, with the model count |
| Model | Whether one is selected, and which |
| Telegram bot | The live poller state, with the resolved `@username` |
| Trace storage | Opening the current month's file for append — the same operation the flusher performs |
| Downloads | Creating and removing a file in the downloads directory — the same thing a download does |

The two storage cards differ in severity, deliberately. An unwritable **trace**
directory is an error: settled traces pile up in RAM and are lost on restart, so it
also raises the global banner. An unwritable **downloads** directory is a warning:
nothing is silently lost, browsing and reporting still work, and only saving a file
fails — loudly, on the run that attempted it. The probe exists so you find out from
this page rather than from a user's failed request.

The bot control card starts and stops the poller. The token comes from Settings, so
there is nothing to type. If the card says "Not configured", go to Settings first.

**What to do here:** confirm every card is green after any config change or restart.
This is the page to look at first when something is not working.

## Analytics (`/analytics`)

There is **no page-level filter**. Every card carries its own period and chat/user
scope, so you can hold last Tuesday's mood next to this month's token trend.

The period control picks a unit (day / week / month / year / all time) and then
navigates between periods of that unit with `◀`/`▶`, or jumps anywhere via the
calendar. Periods that actually hold data are **marked** in the calendar, so you are
not clicking blindly through empty history.

| Card | Shows |
| --- | --- |
| Traffic | Handled, replied, failed, tokens processed/generated, active users, images |
| Mood / Word of the period / Top topic | The LLM-derived read on the conversation — needs the insight job to have run |
| Message volume | Messages per sub-bucket |
| Tokens | Processed (prompt) vs generated (completion) |
| Users | Active and newly-seen |
| Mood trend | The 0–100 mood curve. **Requires a chat** to be selected |
| Model performance | Every recorded LLM round by model **and** by what the call was for, with p50/p95 latency and tokens/sec |
| Top users | The most active senders and the tokens their turns cost |
| Insight job card | Status, backlog (chat-hours), Run now |
| Regenerate card | Drop a period's stored insights and re-score |

**Model performance** is the page to look at when replies feel slow: the call-kind
breakdown separates the addressing check from tool rounds from the final answer, which
otherwise average into one meaningless number.

**Regenerate is destructive and billable.** It deletes every day score covering the
period and re-scores each one with an LLM pass. The button confirms and names exactly
what it will throw away. Use it when a score is wrong, not as routine maintenance.

If a card is empty, first check the calendar marks — the period may genuinely hold no
data.

## History (`/history`)

Lists the chats with stored history. Each links to `/history/{chatId}`, which has:

- **Messages** — the full stored mirror, oldest first, with Telegram ids, the reply
  pointer, timestamps, and edited/deleted flags.
- **Summaries** — the chat's topic summaries grouped by day, newest first, each
  showing the **message ids** it claims to summarize. Those ids are what the bot
  follows back to originals, so when a recall goes wrong this is where you check the
  summary against the actual messages in the Messages tab.
- The summarization job card, with the chat-day backlog and whether embeddings
  (semantic search) are configured at all.

### `/history/transfer`

CSV import and export.

- **Export** writes the canonical header and includes deleted rows, flagged, so an
  export round-trips back through the import.
- **Import** parses your file in the browser to show a live column-mapping preview
  with validation counts, then sends the raw text — the server re-parses it with the
  same code, so the preview cannot disagree with the result.
- **Import is idempotent.** Rows whose `(chat, message id)` already exists are
  skipped, not overwritten, so a partially-applied file is safe to re-run.

Each canonical field can be mapped to a column or given a fixed value — except the
message id, which is the per-chat unique key. Foreign exports usually auto-detect via
the field aliases.

## Vision (`/vision`)

A read-only gallery of media the bot has received. A **pending** row shows its stored
image awaiting a description; a **described** row shows the model's text (its bytes
have been dropped). Voice messages appear here too, with their transcript as the
description.

The backfill job card sits above, with the pending count as its backlog. Backfill only
runs when the bot has been quiet for ~45s, so a busy bot legitimately shows a growing
backlog — it will clear during the next lull. "Run now" arms a run as soon as
possible.

## Users (`/users`)

Every user who has messaged the bot. Two editable fields per row:

| Field | Effect |
| --- | --- |
| **Aliases** | Comma-separated nicknames. They feed the addressing check and let memory tools resolve "Ali" to the right person |
| **Language** | The bot's reply language in that person's **private** chat. Empty means the default (English) |

Each field saves on its own and the input is replaced with what was actually stored,
so you can see the normalization (trimming, deduplication) applied.

The owner is chosen from this list in Settings, which means someone must have messaged
the bot before they can be made owner.

## Groups (`/groups`)

Groups the bot participates in. Each links to `/groups/{chatId}`, which has:

| Field | Effect |
| --- | --- |
| **Notes** | Operator notes (≤2000 chars) injected into the group's chat context on every reply — useful for "this is a work channel, keep it formal" |
| **Language** | The bot's reply language in this group |

Plus the roster of known members with their curated aliases. Aliases are edited on
`/users`, not here.

## Personalities (`/personalities`)

Named personas. Create, edit, delete, and pick the **active** one — whose prompt is
appended to the fixed base system prompt as "Additional instructions". At most 32,
names are case-insensitively unique, prompts up to 32 000 characters.

Deleting the active persona clears the selection (the bot then runs on the base prompt
plus learned self-corrections alone).

To check which persona actually produced a given reply, look at the reply's trace: the
composed system prompt is recorded on it.

## Memory (`/memory`)

What the bot durably knows, and everything here is editable — a bot that remembers the
wrong thing needs a correction path that does not involve a database client.

| Section | Actions |
| --- | --- |
| **Pending queue** | Discard a note before the nightly job folds it into durable memory. This is your chance to catch a fact the bot should not have saved |
| **Per-person documents** | Rewrite one (it is re-embedded), or forget the person entirely — which also drops their pending notes |
| **General knowledge** | Edit the single shared document. It is for knowledge about *nobody* — definitions, rules, conventions. Facts about people do not belong here |

The job card shows **two** backlogs: chat-days passive extraction has not read, and
notes waiting to be folded in. They are different stages of the same pipeline, so a
single number would hide which half is behind.

Nothing in the pending queue is injected into replies or readable by tools — only
consolidated memory is.

## Tools (`/tools`)

Read-only. Every registered MCP tool grouped by the feature that contributes it, with
the description the model actually sees.

There is no on/off switch: all registered tools are always available during a reply.
To see whether a tool was used and what it returned, filter Debug to
`mcp-tools-<feature>` or open the reply trace.

## Self-improvement (`/self-improvement`)

The feedback loop.

| Section | Contents |
| --- | --- |
| **Feedback** | Each 👍/👎 with the option or free text the user chose, and — under it — the bot's own **reflection** on why that exchange went the way it did. The reflection is written outside the reply, so it may be briefly absent |
| **Preferences** | The latest distilled likes/dislikes per user, injected into that person's replies |
| **Self-corrections** | The latest global guidelines, appended to the system prompt on every reply |
| **Addressing exclusions** | Words the analyzer must stop reading as the bot's name, filed by 👎 → "Wasn't talking to you". Remove one to let the analyzer match that word again |
| Job card | The daily incorporation job |

For 👎 reactions to arrive at all in a **group**, the bot must be a group
administrator. In private chats they arrive out of the box.

## Scheduled tasks (`/scheduled-tasks`)

Create, edit, enable/disable and delete tasks, and trigger "run due now". Times are
local wall-clock in the operator timezone.

A task is an **instruction**, not a canned message: when it fires, the bot writes an
in-character message that performs the directive, and the last few deliveries are fed
back so a daily reminder is not word-for-word identical every day.

The job card's **paused** notice matters: maintenance mode stops every fire. Due tasks
stay due and deliver once you turn it off — but until then an enabled task with a
next-run time in the past simply never arrives, and this notice is the only place that
says why.

A task you create here has no author, so the in-chat tools (which are author-scoped)
cannot modify it.

## Browser agent (`/browser`)

Lists runs and lets you start one. A dashboard-started run has no chat to deliver to —
its report is read here — and is treated as your own, so downloads are enabled.

The run view shows the goal, status, the step-by-step activity feed (tool, action,
outcome), the downloads with sizes and whether each was attached to the chat, the
screenshots, live progress while running, and the final report.

Runs are unbounded by design: only the stall guard ends one that stops progressing.
If a run is stuck, that is what to expect it to eventually do — and the forced final
round will still produce a report from what was gathered.

Files larger than `browserDownloadMaxMb` (Settings → Core) are kept in the
`downloads/` folder rather than attached to the chat.

## Background jobs (`/jobs`)

All six background jobs in one place: vision backfill, task poller, history summary,
memory, analytics insights, self-improvement. Each card shows an activity badge,
next/last run, last result, the backlog, a live progress bar while running, "Run now",
and a link to the owning feature's page.

The field to read first is the **notice** — the reason a job is currently *not* doing
its work: paused by maintenance, no LLM configured, nothing to do. A job that silently
declines to run is exactly the failure an operator cannot diagnose from a dashboard
that only ever shows "Enabled".

Note that all daily jobs share one run time (Settings → Core → daily jobs run time).

## Settings (`/settings`)

Six tabs, **one** Save button that persists every changed field regardless of which
tab is open.

| Tab | Contents |
| --- | --- |
| **Core** | LLM connection + model, Telegram token, owner, maintenance mode, timezone, daily jobs run time, browser download cap |
| **Embeddings** | Semantic recall over history summaries and memory search |
| **Images** | Image generation |
| **Speech** | Voice replies |
| **Transcription** | Voice-message speech-to-text (falls back to the chat model when unset) |
| **Integrations** | Tavily key — the browsing agent's search fallback |

Every "Test …" button makes a **real call** and is recorded as a trace. Use them: they
catch things a config check cannot, such as an embedding model whose vector width does
not fit the stored columns.

Secret fields are write-only. They show as "configured" and their values never leave
the server; leaving one untouched keeps the stored value.

Field-by-field reference: [Configuration](../configuration.md#db-backed-settings).

## Debug (`/debug`)

Every feature's traces in one filterable list — filter by feature and status, click
through to the detail view.

A trace detail shows the metadata panel and the ordered event timeline. Each event has
a clean human title plus a stage badge, and its payload can be expanded. Large
payloads (a full system prompt, a long message list, a big tool response) start
collapsed; nothing is hidden permanently.

Trace bodies hold the **complete** raw request and response — not a summary. That is
the point: when a reply is wrong, the trace shows exactly what the model was sent and
what it sent back.

| Action | Notes |
| --- | --- |
| **Download** (one trace / all filtered) | JSON bundle. The right artifact for a bug report — and, because it contains full conversation content, the wrong thing to paste anywhere public |
| **Prune** | Deletes every stored month file **older** than the month you pick. Destructive and irreversible; two-step confirm. There is no automatic retention, so this is the only way stored traces are ever deleted |

Which feature to filter to, by question:

| Question | Filter |
| --- | --- |
| Why did the bot (not) reply? | `bot-messaging` |
| Why did it answer an un-addressed message? | `bot-messaging`, read the `addressing check` event's `matchedText` |
| Did a tool run, and what did it return? | `mcp-tools-<feature>` |
| Why is a recall bad? | `history-summaries` |
| Why did it remember (or forget) something? | `memory`, `memory-extraction` |
| Why did a scheduled message not arrive? | `scheduled-tasks`, then the job card's pause notice |
| What did the browser agent do? | `browser-agent` |
| When did the model/config change? | `settings` |
| Who tried to sign in? | `auth` |
