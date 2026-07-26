# History

**Feature ids:** `history`, `history-summaries` · **Dashboard:** `/history` ·
**SSE topic:** `history` · **Priority 3**

Two layers of conversation memory with opposite properties:

| Layer | Contents | How the bot uses it |
| --- | --- | --- |
| **The mirror** | Every message, verbatim, 1:1 with Telegram | The last 24 hours are injected into every reply |
| **Daily summaries** | Each finished chat-day compressed into a few self-contained topics, embedded, carrying the message ids they came from | Searched by meaning, then followed back to the exact originals |

## The mirror

`chat_messages` is a 1:1 mirror of every chat the bot sees. The runtime records
**every** human message passively — including un-addressed group chatter — and
every delivered reply. Edits and deletes are mirrored as flags.

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

Data: `chat_summaries` (one row per topic, with `embedding vector(1024)`) and
`chat_summary_days` (the per-day processing marker holding the message count at
processing time).

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

Four MCP tools under `mcp-tools-history`. The chat is bound per turn, so a tool
only ever reads the current conversation — the model does not pass (and cannot
pick) a chat id.

| Tool | Kind | Notes |
| --- | --- | --- |
| `history_search` | Literal | Substring, case-insensitive. Served by the trigram index |
| `history_get_in_range` | Literal | ISO-8601 range, oldest first |
| `history_get_by_message_ids` | Literal | Reads a `#<id>` referenced in the transcript; missing ids are omitted |
| `history_recall_topics` | Semantic | Searches the daily summaries by meaning; returns date, summary and message ids |

The split is deliberate: the literal tools are exact but blind (they only find what
was worded the way the query words it), while recall finds a months-old subject the
chat phrased differently — and then hands back ids so the model reads what was
actually said instead of trusting a summary's paraphrase.

## Dashboard

| Page | Contents |
| --- | --- |
| `/history` | Chats with stored history, each linking to its mirror |
| `/history/{chatId}` | The full stored conversation (Messages tab) and the chat's topic summaries grouped by day (Summaries tab), plus the summary job card |
| `/history/transfer` | CSV import/export |

The summaries view shows the **message ids**, not hidden: they are what the bot
follows back to originals, so an operator debugging a bad recall can check a
topic's claim against the mirror in the Messages tab.

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

**Import is idempotent, not destructive.** The mirror's unique
`(chat_id, telegram_message_id)` key means writes skip rows that already exist, so
a partially-applied file can be safely re-run. Export includes deleted rows,
flagged.

Importing also **resets the analytics insight scan floor**, so arbitrarily old
imported hours are picked up by the next insight run.

## Configuration

| Setting | Effect |
| --- | --- |
| `llmBaseUrl` + `model` | Required for the summarization job |
| `embeddingBaseUrl`/`embeddingModel` | Without them, summaries are written but not embedded — no semantic recall |
| `dailyJobsRunTime`, `timezone` | When the job runs, and where the chat-day boundaries fall |

## API

`GET /api/history/summaries`, `POST /api/history/summaries/run` (fire-and-forget),
`GET /api/history/export?chatId=`, `POST /api/history/import`.

## Tracing

| Feature id | Action |
| --- | --- |
| `history` | `import` (CSV), plus mutating edits |
| `history-summaries` | The summarization run, per chat-day |

## Tests

Unit: `csv.test.ts`, `summary.test.ts`, `server/format.test.ts`,
`server/batched-completion.test.ts`.
Integration: `server/history.integration.test.ts`,
`server/summarize.integration.test.ts`, `server/transfer.integration.test.ts`,
`server/tool-selection.integration.test.ts`.
