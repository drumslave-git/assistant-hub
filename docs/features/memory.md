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

`general` holds two things: knowledge about *nobody* (definitions, rules,
conventions, how things work), and facts about people who have **no document of
their own** — someone talked about in a chat they are not a member of (operator
decision, 2026-07-28).

That reverses the 2026-07-17 rule, which dropped such a fact outright. Dropping
targeted a real failure — the document has no identity model, so name-keyed
biography got merged across people and nicknames grew into people of their own —
but it also destroyed facts the bot had just been asked to remember, and it did so
silently. Two guards replace it:

- **The identity check moved to the gate.** A fact about someone the bot *can* key
  on is refused under `general` and must be filed under them
  (`checkGeneralNoteSubject`), so the shared document only ever holds outsiders.
  Conversely, a `user` save naming someone this chat does not know is refused with
  a pointer to `general` rather than a dead end (`resolveMemorySubject`).
- **The merge may not invent an identity.** `GENERAL_MERGE_PROMPT` forbids merging
  two lines about people into one subject or concluding that two names are the
  same person — the mechanism by which one name used to absorb another.

The gate can only act on the subject the model declares (`person`); a `general`
note that names nobody is taken at its word as being about nobody.

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
fact about someone in this chat belongs under `user` and is refused under
`general`, while a fact about anyone else belongs in `general` with their name
written into it; and that facts must be self-contained.

One carve-out (2026-08-19): what a person in this chat is *called* — a nickname,
"call me X", "when I say X I mean Y" — is explicitly **not** saved here, because
name recognition reads the known-users alias table, never memory; the description
points the model at the alias-recording tool instead. Live tool-selection testing
had shown the exact opposite choice 6/6 times (the mapping request landed in
`memory_save` and the alias table never learned the name); the boundary is pinned
by the live suites in `features/{known-users,memory}/server/tool-selection.integration.test.ts`.
The carve-out is tool-path only: passive extraction keeps the full
`DURABLE_FACT_KINDS` (it has no alias-writing path, so "wants to be called X"
harvested from a transcript is still stored as a memory fact rather than dropped).

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

## People, not accounts

A read collects the documents of every identity the operator has declared to be
the same human (person links — see
[users and groups](known-users-and-groups.md)). Both the injected context and
the `memory_recall` tool resolve that way, so a fact learned from someone's
telegram account is theirs when they reach the bot by any other identity; two
linked identities present in one group are one person in the prompt, named
once by the identity actually there.

Reads only. A fact is still stored under the identity that was named, and
consolidation still merges per identity — links do not rewrite what is stored,
they decide whose documents a read collects. Without the v2 core store (the
transitional `STORE_DATABASE_URL`, optional until the Phase 6 cutover) every
identity resolves to itself and memory behaves exactly as it did before links
existed.

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
Integration: `server/memory.integration.test.ts` and
`server/memory-links.integration.test.ts` (reads through person links, both
databases on one container). Extraction and consolidation take injected
collaborators, so the whole flow is driven against a real database with a
deterministic model — no LLM, no network.
