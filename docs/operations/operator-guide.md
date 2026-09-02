# Operator guide

Every dashboard page, what it shows, and what you can do on it.

Two things are true of every page and worth stating once:

- **Data is live.** Pages update themselves over the shared SSE stream. If a page
  looks stale, that is a bug — not something to fix with a reload. The `LiveIndicator`
  pill shows the connection and can be clicked to pause refreshes while you read.
- **Times are in the operator timezone** (Settings → General → Timezone), never your
  browser's local zone and never bare UTC.

## Signing in

`/setup` creates the **first admin account** — a username and a password of at least
8 characters — and exists only while no account exists; afterwards it redirects to
`/login` for good. Every further account is created by an admin on the Accounts page;
there is no open registration.

Accounts have a role, **admin** or **user**. A session is a signed cookie for one
account, valid for 30 days; changing that account's password signs out its other
sessions and nobody else's. An account that was handed a temporary password is held at
`/password` until it chooses its own — it can go nowhere else first.

## Layout

A fixed sidebar on desktop, an off-canvas drawer on mobile, and a sticky top bar with
the message search (admins only), the signed-in account's display name, the theme
toggle and **Sign out**. Above every page sits the global system-alert area — reserved
for failures that silently destroy data if nobody acts. Today there is exactly one:
the trace write path. If that banner appears, read
[Troubleshooting](troubleshooting.md#trace-flush-failures) before doing anything else.

The sidebar footer carries a **Bot status** card (admins only): the same connection
summary the Overview card shows — Running with the bot's `@username` (or "Bots" when
several are up), Error with the message, Stopped, or "Setup needed" with a link to
Settings.

Navigation, in sidebar order:

| Group | Pages |
| --- | --- |
| — | Overview, Analytics |
| Conversations | History, Vision, Users, Groups |
| Bot | Assistants, Memory, Tools, Self-improvement |
| Automation | Tasks, Browser agent, Background jobs |
| System | Backends, Accounts, Settings, Debug |
| Web chat | Chat |
| You | Profile |

A **user**-role account sees only History, Assistants, Tools, Tasks, Debug, Chat and
Profile, each scoped to the assistants it owns. Its landing page is the web chat, and
every admin page — Overview included — sends it there. The API enforces the same
boundary per route, so the sidebar is a convenience, not the lock.

---

## Overview (`/`)

The honest-state page — what is configured *and* what the bot has actually been
doing. Three blocks, in the order they answer questions:

1. **Last 24 hours** — messages handled and answered, failures, active people,
   media described, tokens in/out. Read from the traces, using the same
   aggregation the Analytics page uses, so the two always agree.
2. **System status** — the probes below, grouped into Core (nothing works
   without these), Model roles (optional capabilities) and Storage (write
   paths), each group carrying its own "all clear / needs setup / failing"
   summary. The per-connection bot rows sit under it.
3. **Activity** — three tabs: the latest traced actions, everything that has
   failed (any age — with a line saying how many are recent), and every
   background job's state, next run and last result. The failures and jobs tabs
   badge their counts, so a stalled job or a run of errors is visible without
   opening the tab.

Everything under System status is a **real probe** performed at request time,
never an "is the variable set" guess:

| Card | Probe |
| --- | --- |
| Database | An actual `SELECT 1` |
| LLM endpoint | An actual `/v1/models` call against the chat backend, with the model count |
| Model | Whether a chat model is selected, and which |
| Bots | Every registered transport's `/health`, summarized across **every** connection of every transport: Running (with the `@username` when exactly one bot is up, else the count), Error (a transport this core refused, a transport whose listing failed, or the first failing connection's message — an enabled connection its transport reports nothing for counts as one), Stopped ("Ready — start below"), Not configured ("Connect a bot to an assistant"), or No transport (nothing has registered yet) |
| Trace storage | Opening the current month's file for append — the same operation the flusher performs |
| Downloads | Creating and removing a file in the downloads directory — the same thing a download does |

Each optional role (embeddings, images, speech, audio, vision, browser agent,
classifiers, background jobs) gets its own card, and a neutral card is **not** a
warning:

| Card reads | Means |
| --- | --- |
| Connected | The role has its own model and its endpoint was probed |
| Chat model | The role has no model of its own, so it runs on the chat model ("main by default") — the capability is on. For Audio, Vision and Browser agent the chat model must additionally accept that input (audio, images, tool calls); Classifiers and Background jobs are ordinary completions with nothing extra to require |
| Off | The capability genuinely does not run — no model, and nothing to fall back to |
| Error | A configured endpoint failed its probe |

Only "Error" is a fault. "Chat model" on the Audio, Vision, Browser agent,
Classifiers or Background jobs card is the normal state until you give that role
a model of its own.

The two storage cards differ in severity, deliberately. An unwritable **trace**
directory is an error: settled traces pile up in RAM and are lost on restart, so it
also raises the global banner. An unwritable **downloads** directory is a warning:
nothing is silently lost, browsing and reporting still work, and only saving a file
fails — loudly, on the run that attempted it. The probe exists so you find out from
this page rather than from a user's failed request.

Under the status grid, one block per registered transport (titled with the name
it announced — **Telegram bots**, **Discord bots**, …) lists one row per
connection: its state badge (Running / Error / Stopped), the assistant it serves,
the bot's `@username` (or the masked config, `botToken …xxxx`, while nothing is
polling yet), a Start/Stop button, and the error text when there is one. A
transport this core refused shows its reason instead of rows. With no connection
at all a block says "No bot connections yet — connect a bot to an assistant" and
links to Assistants; with no transport registered at all the page says so. The full control surface
— connect, replace the token, start/stop, disconnect — is each assistant's editor on
`/assistants`; the rows here re-read on every `status` event, so a crash or reconnect
shows up without a reload.

**What to do here:** after any config change or restart, confirm no card is red
and that every neutral one says what you intended. Then check the Activity card:
a job stuck on "Stopped", or a failure count that keeps climbing, is the thing
this page exists to show you before a user does. It is the page to look at first
when something is not working.

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

- **Messages** — the full stored mirror, oldest first, with message ids, the reply
  pointer, timestamps, and edited/deleted flags.
- **Summaries** — the chat's topic summaries grouped by day, newest first, each
  showing the **message ids** it claims to summarize. Those ids are what the bot
  follows back to originals, so when a recall goes wrong this is where you check the
  summary against the actual messages in the Messages tab.
- The summarization job card, with the chat-day backlog and whether embeddings
  (semantic search) are configured at all.

A user-role account sees the chats its own assistants serve; the import/export and
summary-run chrome is the operator's.

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

Everyone who has reached the bot, across every connected source, in two tabs. A
source that could not be read is named above the tabs rather than silently omitted.

**Directory** — one row per identity, labelled by the source that owns it. Two
editable fields per row:

| Field | Effect |
| --- | --- |
| **Aliases** | Comma-separated nicknames. They feed the addressing check and let memory tools resolve "Ali" to the right person |
| **Language** | The bot's reply language in that person's **private** chat. Empty means the default (English) |

Each field saves on its own and the input is replaced with what was actually stored,
so you can see the normalization (trimming, deduplication) applied.

**Linked people** — the person-link graph: the declaration that several identities
(a Telegram user, a dashboard account's web identity, …) are one human. Two things
resolve through these links. **Memory**: what the bot knows about someone follows them
across every identity they reach it by. **Owner rights**: a Telegram sender holds owner
rights over an assistant when the account their identity is linked to *owns* that
assistant; admins hold them over every assistant. Nothing is chosen "as owner"
anywhere any more — the global owner setting is retired.

Admins link identities here (**Link identities**, with an optional note; the picker
offers the whole directory and disables identities another link already claims, since
one identity belongs to at most one person) or break a link again. People can also link
themselves: they mint a one-time code on their [Profile](#profile-profile) and send it
to any connected bot from the identity they want linked.

## Groups (`/groups`)

Every shared conversation the bot takes part in, across every source (a direct chat's
identity is its person, so those are listed under Users). Each links to
`/groups/{ref}` — addressed by scoped ref, e.g. `tg:chat:-100…` — with two tabs:

| Tab | Contents |
| --- | --- |
| **Settings** | **Language** — the bot's reply language in this group. **Notes** — operator notes (≤2000 chars) injected into the group's chat context on every reply, useful for "this is a work channel, keep it formal" |
| **Members** | The roster of known members with their curated aliases. Aliases are edited on `/users`, not here |

## Assistants (`/assistants`)

The bot's identities. Each assistant has its own **persona** and its own **bot
connection**; the assistant in a chat is implied by which bot is in it, so there is no
"active" one to pick (assistants replaced personalities in the redesign). At most 32,
names up to 64 characters, personas up to 32 000.

One card per assistant: name, persona (or "No persona — base system prompt only"),
and — for admins — an owner badge: `owner: <account>`, or `admin-owned` for rows that
predate accounts. A user-role account sees and manages only the assistants it owns.
**New assistant** (the floating button; disabled with "Limit of 32 reached") and
**Edit** open the one dialog: **Name**, **Persona** — appended to the fixed base system
prompt on every reply this assistant sends — and, once the assistant exists, one
connection section per registered transport.

The **Telegram connection** section is rendered from the field schema the transport
announced at registration:

- Not connected yet: a **Bot token** field (from @BotFather; stored by the core and
  never shown again) and **Connect**. Connecting stores the token and the bot starts
  polling at once — a saved connection means "run this"; **Stop** is how you park one.
- Connected: a status badge and the token hint (`botToken …xxxx`), the token field
  again (type a new one and **Save changes** to replace it), **Stop** / **Start**, and
  **Disconnect…** (confirm with **Really disconnect**), which removes the connection
  and its stored config. The assistant itself is untouched.

| Badge | Means |
| --- | --- |
| Running | The transport is polling as `@username` |
| Error | The poller failed and the message is shown — an invalid token, or Telegram refusing a second `getUpdates` consumer for the same token |
| Not tracked | The connection is enabled but the transport reports nothing for it: the service is down, unreachable at the URL it announced, or has not reconciled yet |
| Stopped | Parked by you |

If the section reads "Telegram has not announced itself yet — is its service
running?", the transport has never registered with this core; "No transport has
registered with this core yet" means none has. Both are
[Troubleshooting](troubleshooting.md#the-assistant-editor-says-the-transport-has-not-announced-itself-yet)
material. The badge flips live: the transport publishes every poller change and the
section re-reads.

Deleting an assistant deletes its tasks and its bot connections; any bot it ran stops
polling.

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

Every account can also read and delete the memory held about *its own* identities on
its Profile; there is no way to write memory by hand there.

## Tools (`/tools`)

What the assistants can call while replying, and where those tools come from. Two
tabs.

**Tools (N)** — the catalog. Every tool grouped by the feature that contributes it or
by the connection it came from, with the description the model actually sees and a
Debug link into that group's `mcp-tools-<feature>` traces. Feature tools are code and
always offered — there is no on/off switch; a connection's tools are offered wherever
its scope says, which is written on the group ("offered on every source, for every
assistant").

**Connections (N)** — remote MCP servers you add (at most 32), scoped, discovered and
applied:

- A connection is a **name**, a **slug** (it prefixes the server's tool names, so two
  servers can both have a `search`), an **endpoint URL** and optional **auth headers**
  — write-only: stored values are never shown again, type one to replace it. "Where it
  applies" is every source, Telegram turns only, or web chat turns only; "Which
  assistants may call it" is every assistant or a ticked subset.
- **Discover** asks the server what it offers and shows the drift (`2 new, 1 changed,
  1 gone`); **Apply** hands that set to the assistants. The two verbs are separate on
  purpose (user decision, 2026-08-28): until Apply is pressed the model keeps being
  offered exactly what it was offered before, so a connection can be discovered, read
  and thought about without running conversations noticing. Delete stops offering its
  tools immediately.
- A connection badged **provided by the hub** is one of the platform's own MCP servers
  (the Telegram transport's delivery and reaction tools). Its address and credentials
  come from configuration and its tools follow the deployed release; only where it
  applies is yours to edit, and it cannot be deleted.

A user-role account sees the built-in catalog, its own connections, and its own
assistants in the scope pickers.

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

## Tasks (`/tasks`)

One page for everything the bot does on its own: **standing rules** (act on
matching messages, or shape every reply — for everyone in a group or only for
people you tick off its roster) and **timed jobs** (every N minutes, once after
a delay, or on the calendar). Create, edit, enable/disable and delete, filter
by chat, and trigger "run due now". Times are local wall-clock in the operator
timezone.

Two tasks that say the same thing at the same time are refused as the duplicate
they are — for standing rules on the wording alone, for timed ones on the wording
plus the trigger and its timing. The same wording at a different time is a
separate job and goes through.

A task is an **instruction**, not a canned message. A timed fire runs the model
with the full toolset, and *the model decides what to send* — nothing is
delivered automatically, so "check X and only message if something changed" is
a valid task whose quiet runs are successes, and the last few deliveries are
fed back so a daily reminder is not word-for-word identical every day.

The job card's **paused** notice matters: maintenance mode stops every fire.
Due tasks stay due and fire once you turn it off — but until then an enabled
task with a next-run time in the past simply never arrives, and this notice is
the only place that says why.

A timed task you create here has no author, so the in-chat tools cannot modify
it — unless the person asking holds **owner rights** over that assistant (its
owning account, or any admin), who is exempt and can cancel or edit any task in a
chat they are in. Standing rules in a group are owner-only from chat either way.

The **enable/disable** toggle is yours alone, and disabling hides the task from
the bot completely: it is not listed, read, changed or deleted from a chat, and
asking about it there gets "no such task". Nobody in a chat can pause anything —
when they cancel a task, it is deleted. So a switched-off row is a task only you
can bring back, and the only place its wording still exists (which is the point:
the bot cannot discuss a rule it has no way to carry out).

## Browser agent (`/browser`)

Lists runs and lets you start one. A dashboard-started run has no chat to deliver to —
its report is read here — and is treated as your own, so downloads are enabled.

The run view shows the goal, status, the step-by-step activity feed (tool, action,
outcome), the downloads with sizes and whether each was attached to the chat, the
screenshots, live progress while running, and the final report.

Runs are unbounded by design: only the stall guard ends one that stops progressing.
If a run is stuck, that is what to expect it to eventually do — and the forced final
round will still produce a report from what was gathered.

One size setting under Settings → General: `browserDownloadLimitGb` is the ceiling on
what may be downloaded **at all**; past it the file tool gives up, the stream tool
keeps a truncated but playable video, and the media tool refuses before it starts.
The chat-attach ceiling is fixed at Telegram's 50 MB upload limit. A larger file
from one of your own direct requests (or your own DM rules) is kept in the
`downloads/` folder and reported by name; a rule-driven run in a group — your own
message included — deletes it instead and reports the delivery as failed, without
a notification ping. A group's audience cannot reach your disk, so keeping the
file would only strand it.

## Background jobs (`/jobs`)

All eight background jobs in one place: vision backfill, search index, task poller,
history summary, memory, analytics insights, self-improvement, yt-dlp updater. Each
card shows an activity badge, next/last run, last result, the backlog, a live progress
bar while running, "Run now", and a link to the owning feature's page.

The two idle-debounced jobs run while the bot is quiet. **Vision backfill** describes
media left un-captioned when it arrived. **Search index** indexes each message by what
it says and what its media shows, so history can be searched by meaning; it waits a
little longer than the backfill because it wants that run's descriptions, and with no
embedding model it still indexes the text.

The field to read first is the **notice** — the reason a job is currently *not* doing
its work: paused by maintenance, no LLM configured, nothing to do. A job that silently
declines to run is exactly the failure an operator cannot diagnose from a dashboard
that only ever shows "Enabled".

Note that all daily jobs share one run time (Settings → General → daily jobs run time).

The **yt-dlp updater** card also carries the version of yt-dlp the media downloader
will actually run, and whether it came from the app's self-updated copy or the
system. That badge is worth a glance whenever a media download misbehaves: a stale
yt-dlp fails every media page at once, and **Run now** is the fix.

## Backends (`/backends`)

The endpoint catalog: every OpenAI-compatible server the bot can talk to, entered once
here and picked by role in Settings. A backend is a name, a type, the API URL and a
write-only API key. **Test connection** calls the endpoint for real — it proves the
host answers and the key is accepted, and lists the models it serves. Each card says
which Settings roles currently use it. Create and edit share one dialog (**New
backend** is the floating button); an edit sends only what changed and keeps the stored
key unless the field is touched; deleting asks for confirmation.

## Settings (`/settings`)

Five tabs and **one** Save button — the floating one — that persists every changed
field regardless of which tab is open. It steps aside on the Security tab, whose
password change has its own endpoint and button.

| Tab | Contents |
| --- | --- |
| **Models** | All nine LLM roles as stacked cards on one tab (user decision, 2026-08-14): Chat, Embeddings, Images, Speech (plus the voice name), Audio (plus the transcription mode), Vision, Browser agent, Classifiers, Background jobs. Each picks a backend from the catalog and a model from that backend's live list, has its own Test button, and wears a badge saying what it is set to — the model, "Chat model", "Off", "No model selected", or "*model* — not served" |
| **Telegram** | Maintenance mode: when on, senders with owner rights (an assistant's owning account, and admins) keep full replies; everyone else gets a static notice. Bot tokens are no longer here — they are per assistant, in the assistant editor, and the tab links there |
| **General** | Timezone (IANA), daily jobs run time (`HH:MM` in that zone), **assistant replies in a row** (0–10: how many assistant messages a chat may hold in a row before every assistant there goes quiet until a person speaks; 0 stops assistants answering each other at all), browser download size limit (1–100 GB) |
| **Integrations** | Tavily API key — the browsing agent's search fallback |
| **Security** | The signed-in account's password: current password, new password, its own button. The same form lives on Profile |

The Chat card is the one role that must support thinking and tool calls; every other
role uses the chat backend unless given its own, and most fall back to the chat model
too — so **repointing the chat backend repoints them too**. The last two cards are
where to spend tuning effort once the bot works. **Classifiers** run on every group
message before a reply is even considered, so they set how quickly the bot reacts at
all — a small fast model here is a direct speed win and costs nothing in reply
quality. **Background jobs** are the opposite: nobody waits for them, but what they
write is what later replies recall, so a slower, more capable or longer-context model
belongs there. Both run on the chat model until you say otherwise.

Saving a backend change verifies every stored model selection now served by the new
backend and clears the ones it does not serve, naming them at the top of the Models
tab, where those roles are — pick replacements in their cards. A selection the fetched
model list already proves stale is flagged in its card and cleared with the save.
Nothing is cleared when the new backend cannot be listed. The audio model is spared
only in `transcriptions` mode (whisper-class servers often expose no model listing);
in `chat` mode it is an ordinary chat model and is verified like the rest.

Every "Test …" button does the role's **real work** and shows you the exchange —
the prompt and the reply plus its reasoning, the phrase and the vector, the
prompt and the actual picture, the phrase and audio you can play, the silence and
its transcript, the test image and the description of it, the offered tool and
whether the model called it, the addressing check and the verdict read back out
of it, the short transcript and the topics distilled from it. Each is recorded as
a trace.

Use them. They catch what a config check cannot: an embedding model whose vector
width does not fit the stored columns, a voice name the endpoint silently
substitutes, an image model that answers with an empty payload, a chat model that
returns no reasoning when it is supposed to think, a model that cannot make a
tool call at all — which breaks browsing and every other tool — or one that
answers a classification in prose, which in production reads as "nobody
addressed me" and simply stops the bot from replying when called.

Secret fields are write-only. They show as "configured" and their values never leave
the server; leaving one untouched keeps the stored value.

Field-by-field reference: [Configuration](../configuration.md#db-backed-settings).

## Accounts (`/accounts`)

Who can sign in, and as what. There is no open registration: the first admin comes
from `/setup`, every further account from here.

**Create account** (the floating button): username, optional display name (shown in
chats), role — *User: web chat and their own data* or *Admin: everything* — and a
temporary password (suggested for you, at least 8 characters, shown only in the
dialog). Hand it over out of band; the holder must replace it at first sign-in before
reaching anything else.

The table lists every account with its role, its state — **Active**, **Temporary
password** (not yet replaced), or **Deactivated** — and creation time. Per row:

| Action | Effect |
| --- | --- |
| **Password** | Issues a fresh temporary password: the current one stops working and every session of that account is signed out |
| **Make admin** / **Make user** | Flips the role. Not on yourself |
| **Deactivate** / **Reactivate** | A deactivated account cannot sign in and its sessions stop working. Everything it owns stays, and its assistants answer nothing while it is deactivated; reactivating restores the exact prior state. Not on yourself |
| **Delete…** | Only offered once deactivated. Removes the account **and** its assistants (with their tasks and bot connections), tool connections, chat threads and the memory about them. Irreversible |

The self and last-admin guards are enforced by the service; the page merely greys the
buttons.

## Debug (`/debug`)

Every feature's traces in one filterable, paged list — filter by feature (grouped by
product area: Conversation, People, Knowledge, Automation, Tools, Insights, System,
plus "Other" for ids retired from the registry but still in the data), assistant,
status, correlation id, trigger kind, actor, related id and flow, then click through
to the detail view. A user-role account sees its own assistants' turns.

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
| Did a message reach the pipeline at all? | `bot-messaging`, the `inbound` trace — one per message that opened turns, listing each assistant's turn and its structural verdict |
| Why did the bot (not) reply? | `bot-messaging`, the `reply` trace |
| Why did it answer an un-addressed message? | `bot-messaging`, read the `addressing check` event's `matchedText` |
| Why did every assistant in a shared group go quiet? | `bot-messaging`, a `skipped` reply carrying the loop-guard event |
| Did a tool run, and what did it return? | `mcp-tools-<feature>`; `mcp-tools-connections` for remote servers |
| Why is a recall bad? | `history-summaries` |
| Why did it remember (or forget) something? | `memory`, `memory-extraction` |
| Why did a task's message not arrive? | `tasks`, then the job card's pause notice (a quiet fire is the model's own choice, visible in the fire trace) |
| What did the browser agent do? | `browser-agent` |
| When did the model/config change? | `settings`, `backends` |
| Who connected, stopped or disconnected a bot? | `tool-connections` — the transport registry records its connection writes there |
| Who tried to sign in, who linked an identity? | `auth`, `accounts` |

## Chat (`/chat`)

The web chat: talk to your assistants in the dashboard itself. This is the one page
every account sees, and the user role's whole surface.

Chats down the left with **New chat** at the top, the conversation on the right, the
composer at the bottom. A new chat is a blank conversation, not a form: pick the
assistant ("Talking to", shown only when more than one exists — a chat is always with
exactly one, fixed for its lifetime), say something, and the thread is created by that
first message and **named by the core** from the first exchange; click the title to
rename it, **Delete** to remove it for good.

The composer takes text, an attached image, or a voice note recorded in the browser.
Sending is message-at-once: the reply arrives when the turn produces it, over the same
live stream every other page uses — not as streamed tokens. Web-chat turns run through
the same pipeline as Telegram turns (same tools, memory, persona), and the model is
told it is in the web chat.

## Profile (`/profile`)

Every account's own page — identity, password, and its own memory. Four cards:

| Card | What you can do |
| --- | --- |
| **Who you are** | The username you signed in as and an editable display name (how you appear in chats; empty means the username) |
| **Your identities** | The platform identities linked to this person; memory and owner rights follow these links. **Link another identity** mints a one-time code (`link-xxxxxxxx`, valid 15 minutes, one live code per account — minting again replaces it). Send it, as the whole message, to any connected bot from the identity you want linked, e.g. your Telegram; the bot confirms in the chat and the identity appears here |
| **What the assistant remembers about you** | One document per linked identity, readable in full; **Forget** deletes one. There is no way to write memory by hand |
| **Password** | Current password, new password. Other sessions of this account are signed out; this one stays |

Admins can instead link identities from the Users page; a code sent from an identity
that already belongs to a *different* linked person is refused and needs an admin to
sort the links out.
