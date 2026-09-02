# History

**Feature ids:** `history`, `history-summaries`, `history-index`,
`mcp-tools-history` · **Dashboard:** `/history`, `/search` · **SSE topic:**
`history`

Two layers of conversation memory with opposite properties:

| Layer | Contents | How the bot uses it |
| --- | --- | --- |
| **The mirror** | Every message, verbatim, 1:1 with Telegram | The last 24 hours are injected into every reply |
| **Daily summaries** | Each finished chat-day compressed into a few self-contained topics, embedded, carrying the message ids they came from | Searched by meaning, then followed back to the exact originals |

## The mirror

`source_messages` is a 1:1 mirror of every chat the bot sees, for every
transport, keyed by a `source` discriminator plus source-local text ids. The
ingest (`server/ingest/consumer.ts`) records **every** human message the
transport forwards — including un-addressed group chatter — and every
delivered reply, from the transport's `message.delivered` report. Edits and
deletes are mirrored as flags. Uniqueness is on `(source, dedupe_key)`, a
stream identity the transport computes (`g:<chat>:<msg>` for a group's shared
stream, `d:<chat>:<assistant>:<msg>` for per-bot direct-chat streams), so a
re-delivered update is a no-op without the core knowing the platform's stream
rules; `(source, chat_id, source_message_id)` is indexed for the lookups.

Media rides beside the mirror, not on it: `source_media` is unique on
`(source, chat_id, source_message_id)` and carries **no foreign key** onto the
message row. The ingest still mirrors first and stores media second, as an
ordering, not a constraint. The mirror carries the live-processing semaphore
(`processed`, user decision 2026-07-27): the ingest mirrors with `false` and
the turn's settle releases it to `true`, which is what keeps the vision
backfill off media the reply is still working on. Non-live writers (imports,
assistant replies) always land released.

The content plane — the History and Search pages, the summaries, the search
index and the analytics charts — reads Telegram rows only
(`server/source/tg-content.ts`, `SOURCE = "tg"`, user decision 2026-08-27);
the web chat keeps its transcripts in its own `web_*` tables
([Web chat](web-chat.md)).

Passive capture is high-volume and intentionally **untraced**: the mirror itself is
the record. Mutating operations (a CSV import) are traced end to end.

The mirror is the substrate several other features read: summaries, passive memory
extraction, the analytics volume/user charts, and the history tools.

### Transcript format

History is injected as **one** user message containing a transcript, where every
line is anchored by its Telegram message id:

```
[#1042] Alice: what did we decide about the invoice?
[#1043] [reply to #1042] Bob: we're splitting it
[#1044] You: got it — 50/50 then
```

- `[reply to #<id>]` marks a reply whose target is stored and can be dereferenced;
  when the target is not stored, the quoted text is inlined instead.
- Lines from `You` are the bot's own earlier replies.
- The anchors let the model follow reply chains precisely — who answered whom about
  what — and dereference off-window targets through the history tools.

The window is 24 hours (`HISTORY_WINDOW_MS`).

### The bot's own reactions

When the transport's `set_message_reaction` tool lands a reaction, it reports
it as a `transport.bot-reaction` event and the ingest records it **on the
target message's history record** — `source_messages.bot_reaction` /
`bot_reacted_at`,
state of the row like `edited_at` (user decision, 2026-08-15: a reaction is a
history record, not a separate table). Telegram gives a bot one reaction per
message, so the columns hold the current badge: a re-react replaces it,
removal clears it. `botReactionSuffix` in `format.ts` is the one renderer, so
every consumer of the record — the reply window, the day transcripts, the
dashboard, search hits — shows it on the line, after any media annotation:

```
[#598] alice (@alice_example): hello [you reacted: 👍]
```

This exists because a reaction that lived only on Telegram's side was
invisible to the bot's own memory — it liked a message and then denied having
done so when asked (2026-08-15). Deliberately only the bot's own reactions;
awareness of reactions other people set stays out of scope (user decision,
2026-08-14). The CSV transfer does not carry the columns, so a re-imported
history loses reaction badges (cosmetic).

*Known limitation, out of scope for now:* forum-topic threads
(`message_thread_id`) are not stored, so a forum supergroup's topics interleave
into a single transcript.

## Daily summaries

Every reply already carries the last 24 hours verbatim. Anything older has to be
**searched** — and searching raw messages is poor, because chat is full of "ok",
"lol", and pronouns with no referent. So each finished chat-day is compressed by
the LLM into a handful of self-contained topics, each embedded and each carrying the
Telegram ids it came from: search finds the topic, the ids lead back to the exact
original messages.

Data: `source_summaries` (one row per topic, with `embedding vector(1024)` and
the source-local `message_ids` it came from — no FK, deliberately) and
`chat_summary_days` (the per-day processing marker, keyed by scoped chat ref,
holding the message count at processing time).

Search is **hybrid**: an HNSW cosine index on the embedding, plus a GIN full-text
index on `to_tsvector('simple', content)`. Each query is searched independently
(the model may pass several phrasings) and hits are merged keeping each topic's
best score — a topic that ranks under two phrasings should not be penalized for it.

### The summarization job

Daily, at `settings.daily_jobs_run_time`, under a cross-process advisory lock.

It runs at night because it is the expensive job (one or more LLM passes per
chat-day) and nothing depends on it being fresh — the last 24 hours are already
verbatim in every reply, so a day only needs summarizing once it is over.

Idempotent: the due-scan skips days already summarized *at their current message
count*, so a restart re-triggering the day's run costs nothing, and a day whose
count changed (an import, an edit) is re-summarized.

**Batching and retry.** A day's transcript is batched against a character budget,
which is a guess — the code cannot see the model's tokenization, so a batch the
budget accepted can still be rejected by the endpoint as too large. When that
happens, the not-yet-summarized messages are re-batched at **half** the budget and
the pass retried, down to a floor; batches that already completed are kept. Any
other failure propagates and the day stays pending. This loop
(`server/batched-completion.ts`) is shared with memory extraction, which differs
only in the prompt it builds and the parser it feeds.

Without an embedding model configured, summaries are still written — they just are
not embedded, so semantic recall is unavailable. The job card says so.

## Tools

Four MCP tools under `mcp-tools-history`. (Replying to a message or reacting
to one is the transport's own tool — see
[LLM and MCP](../architecture/llm-and-mcp.md#telegram--the-transports-own-server-mcp-tools-connections).)
The chat is bound per turn, so a tool
only ever reads the current conversation — the model does not pass (and cannot
pick) a chat id.

| Tool | Kind | Notes |
| --- | --- | --- |
| `history_search` | Hybrid | Semantic + full text + substring over every message, media included. Filters by `author` and `media_kinds` |
| `history_get_in_range` | Literal | ISO-8601 range, oldest first |
| `history_get_by_message_ids` | Literal | Reads a `#<id>` referenced in the transcript; missing ids are omitted |
| `history_recall_topics` | Semantic | Searches the daily summaries by meaning; returns date, summary and message ids |

The split is deliberate: the literal tools are exact but blind (they only find what
was worded the way the query words it), while recall finds a months-old subject the
chat phrased differently — and then hands back ids so the model reads what was
actually said instead of trusting a summary's paraphrase.

### How `history_search` finds a photo

It searches the [search index](#search-index), not `source_messages`, and fuses
three pools by reciprocal rank (k=60, the same scheme `history_recall_topics`
uses):

| Pool | Finds | Blind to |
| --- | --- | --- |
| Vector, over the index's embedding | Paraphrase, another language, and **what a picture shows** | Exact rare tokens |
| Full text, over the index's content | Names, error codes, exact tokens | Anything phrased differently |
| Substring, over `source_messages.content` | What was typed, including a message sent minutes ago | Media; anything not typed |

The third pool is the tool's original behaviour and stays because it is the only
one reading the mirror directly: a message sent since the last indexing run has no
index row yet, and a search that could not find it would be a regression the other
two would hide.

Results are **snippets, not messages**: each hit's body is cut to ~220 characters
in the text the model reads, and the default is 10 hits (max 50). A vision
description runs 600–1500 characters, and returning fifty of them in full took one
production reply prompt to 38.8k tokens and got the raw result line pasted into
the chat. The full bodies survive in the structured payload, which is what Debug
records — the loop feeds the model `result.text` only. To read one message in
full, fetch it by its id.

A query is optional when `author` or `media_kinds` is given: "the photos she sent"
is a real lookup with nothing to rank by, and it answers with the most recent
matches. Requiring a query is what made a production turn drop the author filter
and search the whole chat instead.

Hits are ranked to decide *which* messages come back, then rendered
chronologically — a transcript that jumps around in time is hard to read and its
`[reply to #…]` anchors stop lining up. Each line names its author (resolved
through known-users), which is what makes `author` a filter worth trusting: a
reference that matches nobody, or matches several people, is an error result
rather than a silently widened search.

### Search index

`source_message_search` holds each message's searchable text — its own words
**plus its media annotation** — and that text's embedding. Built by an idle
background job traced under `history-index` (`server/index-scheduler.ts`,
`server/index-messages.ts`); see
[background jobs](../architecture/background-jobs.md#message-search-index)
for the staleness rule and the rebuild endpoint.

The point of it: an uncaptioned photo is a `source_messages` row whose `content`
is `''`. No lexical search over the mirror can ever find it, however it is phrased.
What the picture shows lives in `source_media.description`, and joining the two
into one indexed string is what makes "find the photo of the front door"
answerable at all. The same applies to a video, a GIF, a sticker, and a voice
message (whose transcript plays the role of the description).

## Dashboard

| Page | Contents |
| --- | --- |
| `/history` | Chats with stored history, each linking to its mirror |
| `/history/{chatId}` | The full stored conversation (Messages tab) and the chat's topic summaries grouped by day (Summaries tab), plus the summary job card |
| `/history/transfer` | CSV import/export |
| `/search` | Message search across every chat — where the top bar's search box lands |

The summaries view shows the **message ids**, not hidden: they are what the bot
follows back to originals, so an operator debugging a bad recall can check a
topic's claim against the mirror in the Messages tab.

### Message search

`/search` runs `searchHistoryMessages` over the same
[hybrid index](#search-index) the bot's `history_search` reads, so an operator
finds a photo by what is in it exactly as the bot does. Two differences, both
because the reader is a person and not a model:

- **Every chat at once.** `searchChatMessagesHybrid` takes `chatId: null` for
  this. Only the dashboard may pass it — a chat-bound tool always names its own
  chat, because one chat may never read another's messages.
- **Hits are resolved for reading**: the sender's known-user label instead of a
  numeric id, and the id of the trace that handled that turn, so a found message
  is one click from why the bot answered the way it did.

The query lives in the URL (`/search?q=…`), so a search is shareable and survives
a refresh. The page does **not** live-refresh, unlike the status views: a result
set answers a question asked once, and re-running it on every incoming message
would spend an embedding call to reshuffle rows under the reader.

Results are labelled the *closest* messages, not the matching ones, and capped at
25. With an embedding model configured the semantic half always returns its
nearest N whether or not any of them are close, so every query fills the page and
the tail is loosely related by construction. Ranking puts the real matches on
top; the copy says so rather than implying a match that is not there.

## CSV transfer

One CSV dialect for the whole product (`features/history/csv.ts` — pure and
client-safe). The import page parses the operator's file **in the browser** with the
same module to render the column-mapping preview; the server then re-parses the raw
text with that same module before writing, so the preview, the validation counts
and the actual import can never disagree — and the client's parse is never trusted.

Canonical columns, in export order:

| Column | Required | Can be a fixed value |
| --- | --- | --- |
| `chat_id` | yes | yes |
| `telegram_message_id` | yes | **no** — it is the per-chat unique key, so one value would collapse the file into a single message |
| `role` | yes | yes (`user`/`assistant`; `human`/`bot` accepted) |
| `content` | yes | yes |
| `sent_at` | yes | yes |
| `user_id` | no | yes |
| `reply_to_message_id` | no | yes |
| `edited_at` | no | yes |
| `deleted_at` | no | yes |

Each field carries aliases so a foreign export auto-detects its mapping. An export
writes the canonical header, so it round-trips straight back through the import.

**Import is idempotent, not destructive.** Imported rows get the group-stream
dedupe key of their `(chat_id, telegram_message_id)`, and the mirror's unique
`(source, dedupe_key)` index means writes skip rows that already exist, so a
partially-applied file can be safely re-run. Export includes deleted rows,
flagged.

Importing also **resets the analytics insight scan floor**, so arbitrarily old
imported hours are picked up by the next insight run.

## Configuration

| Setting | Effect |
| --- | --- |
| Chat backend + `model` | Required for the summarization job |
| `embeddingBackendId`/`embeddingModel` | Without a model, summaries are written but not embedded — no semantic recall (the backend defaults to the chat backend) |
| `dailyJobsRunTime`, `timezone` | When the job runs, and where the chat-day boundaries fall |

## API

`GET /api/history/summaries`, `POST /api/history/summaries/run` (fire-and-forget),
`GET /api/history/export?chatId=`, `POST /api/history/import`, and the search
index's `GET|POST|DELETE /api/history/search-index` (status, "Index now", and
empty-and-rebuild).

## Tracing

| Feature id | Action |
| --- | --- |
| `history` | `import` (CSV), plus mutating edits |
| `history-summaries` | The summarization run, per chat-day |
| `history-index` | The search-index runs |
| `mcp-tools-history` | Every call of the four tools |

## Tests

Unit: `csv.test.ts`, `summary.test.ts`, `server/format.test.ts`,
`server/batched-completion.test.ts`, `server/mcp-tools.test.ts`.
Integration: `server/history.integration.test.ts`,
`server/search-index.integration.test.ts` (the index, the hybrid search and the
dashboard's cross-chat search), `server/summarize.integration.test.ts`,
`server/transfer.integration.test.ts`, `server/tool-selection.integration.test.ts`.
