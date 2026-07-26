# Data model

Postgres, accessed through [Drizzle ORM](https://orm.drizzle.team).
`db/schema.ts` is the single source of truth; SQL migrations under
`db/migrations/` are generated from it.

Two things are deliberately **not** in the database:

- **Traces.** They live in append-only monthly NDJSON files under `TRACES_DIR`.
  See [Observability](observability.md).
- **Ids.** Generated in application code (`crypto.randomUUID()`), so the shared
  schema needs no id-generating extension.

Extensions in use: `vector` (pgvector, for the 1024-wide embedding columns),
`pg_trgm` (the trigram index behind `history_search`'s substring matching). Both
are enabled by migrations; the Compose `db` service uses the
`pgvector/pgvector:pg17` image.

## Table map

```
settings ──active_personality_id──► personalities

known_users ◄──┬── group_members ──► known_groups
               ├── users_feedbacks ──► addressing_exclusions
               ├── users_communication_preferences
               ├── memory_entries
               └── user_memories

chat_messages ── (chat_id, telegram_message_id) ─┬─ message_media ──► media_blobs
                                                 └─ (mirrors every message)
chat_summaries        ◄── chat_summary_days        (per-day processing markers)
memory_extraction_days                             (per-day processing markers)
chat_hour_insights ──rolls up──► period_insights

browser_agent_runs ──► browser_run_screenshots
general_memories      self_corrections      scheduled_tasks
```

---

## Configuration and identity

### `settings`

One row, `id = 'singleton'`, enforced by a `check` constraint. New settings are
added as typed columns with defaults plus a migration; the repository always
reads and writes the one row.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Always `'singleton'` |
| `llm_base_url`, `llm_api_key`, `model` | text | Core LLM connection. The key is a secret and never leaves the server |
| `active_personality_id` | text → `personalities.id` | `ON DELETE SET NULL` — deleting the active persona clears the selection |
| `operator_password_hash` | text | scrypt, self-describing format. Null → `/setup` is open |
| `session_secret` | text | HMAC key for session cookies. Rotating it invalidates every session |
| `telegram_bot_token` | text | Secret |
| `tavily_api_key` | text | Secret; the browsing agent's search fallback |
| `embedding_base_url`, `embedding_api_key`, `embedding_model` | text | Null base URL/key reuses the core connection |
| `image_base_url`, `image_api_key`, `image_model` | text | Same fallback |
| `speech_base_url`, `speech_api_key`, `speech_model`, `speech_voice` | text | Same fallback |
| `transcription_base_url`, `transcription_api_key`, `transcription_model` | text | Same fallback; null model falls back to the chat model |
| `owner_username`, `owner_user_id` | text | Owner is chosen from known users; username is denormalized for display |
| `maintenance_mode_enabled` | boolean, default `false` | Closes the bot to everyone but the owner and pauses task fires |
| `timezone` | text, default `UTC` | IANA name; the operator timezone |
| `daily_jobs_run_time` | text, default `04:00` | Local `HH:MM` all daily jobs run at |
| `browser_download_max_mb` | integer, default `20` | Cap for attaching a browser-agent download to the chat |
| `updated_at` | timestamptz | Last write |

### `personalities`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `name` | text NOT NULL | Case-insensitive uniqueness enforced in the service, not the schema |
| `prompt` | text NOT NULL, default `''` | Appended to the base system prompt as "Additional instructions" |
| `created_at`, `updated_at` | timestamptz | |

Index: `personalities_name_idx (name)`. Bounds (32 personalities, 64-char name,
32 000-char prompt) are enforced by the zod contract.

### `known_users`

Everyone who has messaged the bot. Upserted passively on every message.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | text PK | Telegram's numeric user id, as a string |
| `username`, `first_name`, `last_name` | text | From Telegram |
| `aliases` | text[] NOT NULL, default `{}` | Operator- and model-curated nicknames; used by addressing and by person resolution in tools |
| `language` | text | Free text. Governs the bot's reply language in that person's DM |
| `first_seen_at`, `updated_at` | timestamptz | |

Index: `known_users_username_idx (username)`.

### `known_groups`

| Column | Type | Notes |
| --- | --- | --- |
| `chat_id` | text PK | Negative for groups/supergroups |
| `title`, `type` | text | From Telegram |
| `notes` | text | Operator notes (≤2000 chars), injected into the chat context |
| `language` | text | Governs the bot's reply language in this group |
| `first_seen_at`, `updated_at` | timestamptz | |

### `group_members`

Composite PK `(chat_id, user_id)`, both FKs `ON DELETE CASCADE`. Indexes on each
column. This is the roster the reply prompt's chat context is built from.

---

## Conversation mirror

### `chat_messages`

A 1:1 mirror of every message in every chat the bot sees — human and assistant,
addressed or not. This is the substrate the history window, summaries, passive
memory extraction and the analytics volume charts all read.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `chat_id` | text NOT NULL | |
| `telegram_message_id` | bigint NOT NULL | |
| `role` | text NOT NULL | `check`: `user` \| `assistant` |
| `user_id` | text | Null for assistant rows |
| `content` | text NOT NULL | Can be empty for a media-only row |
| `reply_to_message_id` | bigint | The Telegram id being replied to |
| `sent_at` | timestamptz NOT NULL | Telegram's timestamp |
| `edited_at`, `deleted_at` | timestamptz | Edit/delete flags, mirrored from updates |
| `created_at` | timestamptz | When we captured it |

- Unique `chat_messages_chat_msg_idx (chat_id, telegram_message_id)` — this is
  what makes CSV re-import idempotent rather than destructive.
- `chat_messages_chat_sent_idx (chat_id, sent_at)` — the 24-hour window read.
- `chat_messages_content_trgm_idx` — GIN trigram index serving
  `history_search`'s arbitrary-substring `ILIKE`. Without it every search is a
  sequential scan of the chat's full mirror.

### `chat_summaries`

One row per topic distilled from a finished chat-day.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `chat_id` | text NOT NULL | |
| `summary_date` | text NOT NULL | `YYYY-MM-DD` in the operator timezone |
| `content` | text NOT NULL | A self-contained topic summary |
| `message_ids` | bigint[] NOT NULL, default `{}` | The Telegram ids this topic came from — how recall leads back to originals |
| `embedding` | vector(1024) | Null when embedding failed or is unconfigured |
| `created_at` | timestamptz | |

Indexes: `(chat_id, summary_date)`; an HNSW cosine index on `embedding` for the
vector half of hybrid search. The full-text half is a GIN index on
`to_tsvector('simple', content)`, added directly in the migration (an expression
index has no Drizzle column to hang off).

### `chat_summary_days`

Per-day processing marker, unique on `(chat_id, summary_date)`. Holds
`message_count` and `topic_count` at the time of processing, which is what makes
the due-scan idempotent: a day already summarized *at its current message count*
is skipped.

### `message_media`

Every image, sticker, GIF, video or voice note the bot has seen.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `chat_id`, `telegram_message_id` | text / bigint | Unique together |
| `kind` | text NOT NULL | e.g. `photo`, `sticker`, `animation`, `video`, `voice` |
| `file_id`, `file_unique_id` | text | Telegram file handles |
| `mime_type` | text | |
| `vision_hint` | text | e.g. a sticker's emoji, passed to the describer |
| `description` | text | The model's description, or a voice transcript |
| `status` | text NOT NULL, default `pending` | `check`: `pending` \| `described` \| `unavailable` |
| `created_at`, `described_at` | timestamptz | |

Index `message_media_status_idx (status, created_at)` — the backfill job scans
pending rows oldest first.

### `media_blobs`

Composite PK `(media_id, frame_index)`, FK `ON DELETE CASCADE`. Real `bytea`, one
row per frame (a video contributes several sampled frames). Bytes exist **only
while the media row is `pending`**: describing a row drops them. The repository
converts to/from base64 so callers never handle `Buffer`s.

---

## Automation

### `scheduled_tasks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `chat_id` | text NOT NULL | Where the task delivers |
| `thread_id` | bigint | Forum topic, when applicable |
| `created_by_user_id` | text | The author. Only the author may edit/cancel via the chat tools |
| `instruction` | text NOT NULL | The self-contained directive (≤2000 chars) |
| `schedule_kind` | text NOT NULL | `check`: `once` \| `daily` \| `weekly` |
| `time_of_day` | text NOT NULL | Local `HH:MM` in the operator timezone |
| `weekdays` | integer[] | For `weekly`; 0 = Sunday |
| `run_date` | text | For `once`; `YYYY-MM-DD` |
| `enabled` | boolean NOT NULL, default `true` | |
| `attempts` | integer NOT NULL, default 0 | Consecutive failed fires of a due one-shot (capped at 5) |
| `recent_deliveries` | jsonb `string[]`, default `[]` | Last few delivered texts, for wording variation |
| `last_run_at`, `next_run_at` | timestamptz | `next_run_at` is recomputed after each fire |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `(chat_id)`, and `scheduled_tasks_due_idx (enabled, next_run_at)` — the
poller's scan.

### `browser_agent_runs`

The run row **is** the queue.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `chat_id` | text | Null for a dashboard-started run (nothing is delivered; the report is read on the page) |
| `thread_id` | bigint | |
| `created_by_user_id` | text | |
| `is_owner` | boolean NOT NULL, default `false` | Resolved at enqueue time; gates the download tools inside the run |
| `goal` | text NOT NULL | |
| `status` | text NOT NULL, default `queued` | `check`: `queued` \| `running` \| `done` \| `failed` |
| `report`, `error` | text | The agent's final report / the failure reason |
| `steps` | integer NOT NULL, default 0 | Browser actions performed |
| `activity` | jsonb `BrowserAgentStepJson[]` | The ordered activity feed |
| `downloads` | jsonb `BrowserAgentDownloadJson[]` | Files fetched, with sizes and whether they were attached |
| `trace_id` | text | For Debug drill-down |
| `created_at`, `started_at`, `finished_at` | timestamptz | |

Indexes: `browser_agent_runs_status_idx (status, created_at)` — the runner's
queued scan — and `(chat_id)`.

### `browser_run_screenshots`

Composite PK `(run_id, seq)`, FK `ON DELETE CASCADE`. JPEG bytes in `bytea`, plus
the `url` and `title` at capture time. Served by
`GET /api/browser/{id}/screenshot/{seq}` — never embedded in trace JSON, per the
binary-payload convention.

---

## Memory

### `memory_entries`

The pending queue. Two producers: the `memory_save` tool mid-reply, and nightly
passive extraction over the mirror. A note becomes memory only once consolidated;
the queue itself is neither injected into prompts nor readable by tools.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `scope` | text NOT NULL | `check`: `user` \| `general` |
| `user_id` | text → `known_users` CASCADE | |
| `content` | text NOT NULL | |
| `chat_id` | text | Provenance only, not a scope |
| `created_at` | timestamptz | |

A `check` enforces `(scope = 'user') = (user_id is not null)`: a user note must
name its person and a general note must not. Index on `(scope, user_id)`.

### `user_memories`

One consolidated document per person. PK is `user_id` (FK CASCADE), so forgetting
a person removes their document and — by cascade on `memory_entries` — their
pending notes too. `embedding vector(1024)` with an HNSW cosine index for
semantic memory search.

### `general_memories`

Singleton (`id = 'singleton'`, default). **One** document of cross-chat shared
knowledge: definitions, rules, conventions — knowledge about *nobody*. Facts
about people never belong here (user decision, 2026-07-17): the document has no
identity model, so name-keyed biography got merged across people. Never searched,
always injected in full.

### `memory_extraction_days`

Per-day marker for passive extraction, unique on `(chat_id, extraction_date)`,
holding `message_count` and `note_count`. A deliberate twin of
`chat_summary_days` — kept separate so the two jobs fail, re-run and backfill
independently.

---

## Feedback and learning

### `users_feedbacks`

One row per 👍/👎 reaction on a bot reply.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `chat_id`, `telegram_message_id` | text / bigint | The reacted reply |
| `user_id` | text → `known_users` CASCADE | Who reacted |
| `reaction` | text NOT NULL | `check`: `up` \| `down` |
| `feedback` | text | The chosen option's text, or the user's own words. Null until answered |
| `status` | text NOT NULL, default `pending` | `check`: `pending` \| `awaiting_text` \| `completed` |
| `topic` | text NOT NULL, default `quality` | `check`: `quality` \| `addressing` |
| `menu_message_id` | bigint | The options menu message |
| `model` | text NOT NULL | Clean model name that produced the reacted reply |
| `reflection`, `reflection_model` | text | The bot's own account of why the exchange went that way |
| `prefs_version`, `corrections_version` | integer | Which distilled versions incorporated this row; null = not yet incorporated |
| `created_at`, `updated_at` | timestamptz | |

Unique `(chat_id, telegram_message_id, user_id)`; indexes on `status` and on
`(user_id, prefs_version)` — the daily job's scan for completed-but-unincorporated
rows.

### `users_communication_preferences`

Versioned per-user preference documents (`likes`, `dislikes`, `model`,
`version`), unique on `(user_id, version)`. The latest version for the sender is
injected into their replies.

### `self_corrections`

Versioned global self-correction guidelines (`correction`, `model`, `version`),
unique on `version`. The latest is appended to the system prompt on every reply.

### `addressing_exclusions`

Words the addressing analyzer must stop reading as the bot's display name, filed
when someone answers 👎 → "Wasn't talking to you".

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `term` | text NOT NULL | The word verbatim as it appeared |
| `normalized` | text NOT NULL | Case-folded, whitespace-collapsed — what the mechanical check matches. **Unique** |
| `bot_display_name` | text NOT NULL | The name the false match was made against |
| `chat_id`, `telegram_message_id` | text / bigint | Provenance; the exclusion applies bot-wide |
| `user_id` | text → `known_users` SET NULL | |
| `feedback_id` | text → `users_feedbacks` SET NULL | |
| `created_at` | timestamptz | |

---

## Analytics

Both tables hold **LLM-derived** insight only. Message volume, users, tokens and
model performance are computed live — volume/users from `chat_messages`, tokens
and model performance from the trace files.

### `chat_hour_insights`

One row per scored chat-**hour**: `mood_score` (0–100), `mood_label`,
`mood_summary`, `top_topic`, `word`, `message_count`, `model`. Unique on
`(chat_id, insight_hour)`. The hour is the finest thing the dashboard plots, and
a scored hour is final — the job never re-reads it.

### `period_insights`

Hierarchical roll-ups: hour → day → week/month → year → all time.

| Column | Notes |
| --- | --- |
| `granularity` | `check`: `hour` \| `day` \| `week` \| `month` \| `year` \| `all` |
| `bucket` | The bucket key at that granularity (`2026-07-16 14`, `2026-07-16`, `2026-07`, `2026`, `all`) |
| `chat_id` | |
| `word_of_period`, `top_topic` | Selected by one cheap LLM pass over the children |
| `mood_score`, `mood_label` | A deterministic message-weighted mean of the children |
| `source_units`, `message_count`, `model`, `computed_at` | |

Unique on `(granularity, bucket, chat_id)`. Each level reads only its immediate
children, so a month is rolled up from ~31 days rather than ~700 hours.

---

## Migrations

```bash
npm run db:generate   # emit SQL from db/schema.ts into db/migrations/
```

```bash
npm run db:migrate    # apply pending migrations to DATABASE_URL
```

Rules:

- Edit `db/schema.ts`, generate, **and apply**. Generating without applying
  leaves your dev database on the old schema while the code expects the new one.
- Commit the generated SQL.
- Hand-written SQL belongs in the generated file when drizzle-kit cannot express
  it — the `pg_trgm` extension, the expression-based full-text index on
  `chat_summaries`. Both are noted in `db/schema.ts` comments.
- In deployment the same `drizzle-kit migrate` step runs as the container's
  entrypoint before `next start`, so the app never serves against an unmigrated
  database.

`db/migrations/0026_drop_trace_tables.sql` is where traces left Postgres for the
file store; `0027_add_analytics_facts.sql` and later reflect analytics moving to
reading the trace files directly.
