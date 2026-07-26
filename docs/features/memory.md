# Memory

**Feature ids:** `memory`, `memory-extraction` · **Dashboard:** `/memory` ·
**SSE topic:** `memory` · **Priority 10**

Durable knowledge the bot keeps across conversations — what history cannot do,
because history's verbatim window is 24 hours and a fact said last month is gone
from it.

## Two scopes, both merged documents

| Scope | Shape | Injected |
| --- | --- | --- |
| `user` | **One document per person** | Into the replies of chats they take part in |
| `general` | **ONE** document of cross-chat shared knowledge | Into every reply |

Both are stored as merged documents rather than sets of independent facts
(operator decision, 2026-07-16). Merging per-document is what makes contradiction
resolution possible at all: the model sees the whole picture it is rewriting, so
"moved to Lisbon" can supersede "lives in Porto".

`general` is knowledge about *nobody*: definitions, rules, conventions, how things
work. It is explicitly **not** a home for facts about people the bot cannot key on
(operator decision, 2026-07-17) — such a fact is dropped. Keeping it there was the
biggest source of wrong memory: the document has no identity model, so name-keyed
biography got merged across people and nicknames grew into people of their own.

## The pipeline

```
producer 1: memory_save tool (mid-reply)  ─┐
                                           ├─► memory_entries (pending queue)
producer 2: nightly passive extraction    ─┘            │
                                                        ▼
                                       nightly consolidation (document merge)
                                                        │
                                        user_memories / general_memories
                                                        │
                                                        ▼
                                          injected into every reply
```

A note becomes memory **only once consolidated**. The pending queue is neither
injected into prompts nor readable by tools (user decision): what the model sees is
the merged, deduplicated, contradiction-resolved picture — not a running log of
every note ever saved.

### Producer 1: the `memory_save` tool

Called by the model while composing a reply. One fact per call. Its description is
long by design and states the things a model gets wrong otherwise: that saying
"I'll remember that" without calling the tool is a false promise; that it must save
proactively when someone reveals something lastingly true about themselves; that a
fact about a person never belongs in `general` even with the name written in; and
that facts must be self-contained.

### Producer 2: passive extraction

The tool only runs while the model is composing a reply — and the bot only replies
when addressed. In a group that meant the bot learned from the handful of turns
aimed at it and remembered nothing from the conversation going on around it, which
is exactly where people mention where they live, what they do and who they are.

Nothing about addressing changes to fix that. The **mirror already stores every
message** regardless of addressing, so extraction reads the mirror: one LLM pass
per finished chat-day, harvesting durable facts into the same queue the tool writes
to. Consolidation then folds them in exactly as before — it neither knows nor cares
which producer queued a note.

The pass is **many facts per call**, unlike the tool's one per call: the model is
reading a finished transcript rather than deciding mid-reply, so it can see the whole
day at once and a single pass is far cheaper than one call per candidate fact. It
reuses the tool's durability policy (`DURABLE_FACT_KINDS` et al.) rather than
restating it — the same sentence must be worth remembering whether or not the bot
happened to be spoken to.

Markers: `memory_extraction_days`, unique on `(chat_id, extraction_date)`, holding
the message count at processing time. A deliberate twin of `chat_summary_days`, kept
separate so the two jobs fail, re-run and backfill independently.

### The nightly job

Daily at `settings.daily_jobs_run_time`, **two passes in order**, one run and one
lock:

1. **Extraction** — read each finished chat-day out of the mirror and queue what it
   revealed.
2. **Consolidation** — fold the whole pending queue into durable memory: one LLM
   call per *person* with a backlog, plus one call for the single general document.

Extraction runs first so a day's facts reach durable memory the **same** night they
are harvested rather than sitting in the queue until the next one. They are one run
rather than two schedulers because they are strictly sequential and share the lock —
a consolidation racing the extraction that feeds it would just leave half the
night's notes for tomorrow.

Failure semantics, which matter more here than anywhere else:

- A pass that fails leaves its notes **pending** for the next run rather than losing
  them.
- A note that succeeds is deleted, so it is never re-spent on the LLM.
- An **empty merge is treated as a failed pass**, never as "this is now empty". A
  garbage model response can never erase a document that took months to build.

## Injection

Both scopes are injected on every reply (operator decision, 2026-07-16): the durable
picture of the people in this conversation, and the whole general document.

General memory used to be tool-only, retrieved a few facts at a time, on the
reasoning that it grows without bound and most of it is irrelevant to any one
question. The trade was reversed because knowledge the bot has to *think to look
up* is knowledge it mostly does not use — and the nightly merge is what keeps the
document from sprawling.

## Data

| Table | Notes |
| --- | --- |
| `memory_entries` | The pending queue. A `check` enforces that a `user` note names its person and a `general` note does not |
| `user_memories` | PK is `user_id`; `embedding vector(1024)` with an HNSW cosine index |
| `general_memories` | Singleton row. Never searched, always injected in full |
| `memory_extraction_days` | Per-day extraction markers |

Embeddings are optional and only affect `user` memory (general is never searched).
With none configured, memory is still stored and still injected — only
`memory_search` degrades.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Record one durable fact |
| `memory_get` | Read everything durably known about one person |
| `memory_search` | Semantic search across durable facts about people, including people not in this chat |

The person a `user` fact is about defaults to the bound speaker and is otherwise
named by a name the model already sees — never a numeric id, which the model is
never given. That reference is resolved to a real participant of the current chat,
so a tool can only ever touch someone who has actually messaged in this
conversation.

## Dashboard

`/memory` shows the pending queue, each person's memory document, the general
document, and the nightly job card. Everything is **editable**, because a bot that
remembers the wrong thing needs a correction path that does not involve a database
client:

| Action | Effect |
| --- | --- |
| Discard a pending note | Drops it before the nightly job folds it in |
| Rewrite a person's document | Saved and **re-embedded** |
| Forget a person | Drops their document and, by cascade, their pending notes |
| Edit the general document | Upsert — the first edit creates it |

The job card shows **both** backlogs separately (chat-days to read, notes to fold
in): they are different units and different stages of the same pipeline, so
collapsing them into one number would hide which half is behind.

## API

`GET /api/memory` (aggregate view + job info), `POST /api/memory/run`
(fire-and-forget), `DELETE /api/memory/entries/{id}`,
`PATCH|DELETE /api/memory/users/{userId}`, `PATCH|DELETE /api/memory/general`.

There is no id in the general path and no `POST`: general knowledge is one
document, so writing it is an upsert and there is nothing to address individually.

## Tracing

| Feature id | Covers |
| --- | --- |
| `memory` | Tool saves, consolidation, operator edits |
| `memory-extraction` | The passive extraction half of the nightly run |

Split for the same reason `history-summaries` is split from `history`: one nightly
run produces both, and an operator asking "what did the bot decide to remember from
Tuesday" must be able to filter to that half alone.

## Tests

Unit: `prompt.test.ts`, `extract-prompt.test.ts`, `format.test.ts`.
Integration: `server/memory.integration.test.ts`. Extraction and consolidation take
injected collaborators, so the whole flow is driven against a real database with a
deterministic model — no LLM, no network.
