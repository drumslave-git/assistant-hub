# Data model

Postgres, accessed through [Drizzle ORM](https://orm.drizzle.team). One
database serves the whole platform: `store/schema.ts` is the single source of
truth and the SQL migrations under `store/migrations/` are generated from it
(`drizzle.config.ts` points at both). A transport has no database of its own —
it is a stateless transport; everything it needs remembered lands in the
tables below.

Paths in this document are relative to `apps/core/` unless they start with
`apps/` or `packages/`.

Extensions in use: `vector` (pgvector, for the 1024-wide `embedding` columns —
`EMBEDDING_DIMENSIONS` in `packages/contracts/src/embeddings.ts`) and
`pg_trgm` (the trigram indexes behind `history_search`'s substring matching).
Both are created by hand-written statements in the migration chain (`0000`
and `0007`); the Compose `db` service uses the `pgvector/pgvector:pg17` image.

## Conventions

- **Ids are generated in application code.** Entity tables use text primary
  keys minted with `crypto.randomUUID()`; append-only logs (`source_messages`,
  `web_messages`, `source_summaries`, the per-day job markers, the analytics
  rows) use `bigint generated always as identity`, whose value is the
  insertion order. No id-generating extension is needed.
- **Scoped refs, never foreign keys into another app's data.** A `*_ref`
  column holds a string `<source>:<kind>:<id>` — `tg:user:123`,
  `tg:chat:-100…`, `chat:user:<accountId>`, `chat:thread:<id>` — where the id
  is the owning source's own key verbatim (`packages/contracts/src/scoped-ref.ts`;
  sources `tg` and `chat`, kinds `user`, `chat`, `thread`, `message`). Memory,
  tasks, person links, job markers and every provenance column speak refs;
  only the owning source resolves one. Since Phase 8 the account *is* its
  web-chat identity, so `chat:user:<accountId>` names an account.
- **Source-local text ids.** The conversation store keys rows on a `source`
  discriminator plus the platform's own ids as text (`chat_id`, `user_id`,
  `source_message_id`), never assuming they are numeric. Ordering comes from
  the identity `id`, never from the source id. Details that mean something
  only to one source (a forum-topic `thread_id`) keep their own columns.
- **Dedupe keys.** A transport computes each stored message's stream identity
  with `messageDedupeKey` (`packages/contracts/src/source-events.ts`):
  `<chatId>:<sourceMessageId>` for a shared stream (a Telegram group, which
  every poller mirrors idempotently) and `<chatId>:<assistantId>:<sourceMessageId>`
  for a per-assistant stream (a Telegram DM, where message ids are numbered
  per bot). The core enforces uniqueness on `(source, dedupe_key)` and never
  inspects a chat id's sign.
- **Timestamps are `timestamp with time zone`** (`*_at` columns). Calendar
  keys the jobs bucket by are text in the operator timezone: `YYYY-MM-DD`
  days, `YYYY-MM-DD HH` hours.
- **Opaque jsonb the core never interprets.** `transports.config`,
  `assistant_transports.config` (where a Telegram bot token lives) and
  `tool_connections.auth_headers` are validated only against the schema their
  owner announced; the core stores and forwards them.
- **Enums are text plus a `check` constraint**, listed per table. Secrets
  (`backends.api_key`, `accounts.password_hash`, `accounts.session_secret`,
  `settings.tavily_api_key`, `tool_connections.auth_headers`, transport
  connection config) are never returned in plaintext by a service.
- **Binary payloads are real `bytea`** (a `customType` in the schema), kept in
  their own `*_blobs` / screenshot tables so the hot reads never drag bytes.

## Table map

```
accounts ◄──┬── account_link_codes
            ├── assistants (owner_account_id, SET NULL) ──┬── assistant_transports ··► transports
            │                                             ├── assistant_tool_connections ──► tool_connections ──► tool_connection_tools
            │                                             └── tasks
            ├── tool_connections (owner_account_id)
            └── web_threads ──► web_messages ──► web_media ──► web_media_blobs

settings ──*_backend_id (RESTRICT)──► backends

source_users ··┬·· source_chat_members ··► source_chats ◄·· source_chat_assistants
               └·· source_feedbacks
source_messages ·· (source, chat_id, source_message_id) ··┬·· source_message_search
                                                          ├·· source_media ──► source_media_blobs
                                                          └·· source_summaries.message_ids
person_links ──► person_link_members                    (user_ref, one link per ref)
memory_entries · user_memories · general_memories       (user_ref / origin_chat_ref)
communication_preferences · self_corrections · addressing_exclusions
chat_summary_days · memory_extraction_days              (per-day job markers, chat_ref)
turn_actions                                            (correlation_id)
browser_agent_runs ──► browser_run_screenshots
chat_hour_insights ··rolls up··► period_insights
search_engine_stats
```

`──►` is a foreign key (cascade behaviour noted per table); `··►` is a scoped
ref or a shared source-local key with no constraint.

---

## Accounts and identity

See [Security](security.md) for the sign-in flow.

### `accounts`

Who signs in (redesign Phase 8). The first admin is created by first-run
`/setup`; admins create further accounts with a temporary password. Session
cookies are HMAC-signed with the account's own secret, so rotating it signs out
that account and nobody else. The operator password and the global owner
setting are retired — owner rights resolve per assistant through
`assistants.owner_account_id` and the person-link graph.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `username` | text NOT NULL | Sign-in name; unique case-insensitively (`accounts_username_unique` on `lower(username)`) |
| `display_name` | text | Shown in chat rosters and the dashboard; null falls back to `username` |
| `aliases` | text[] NOT NULL, default `{}` | Operator-curated alternate names (addressing, directory search) |
| `language` | text | Curated reply language for this person, or null |
| `password_hash` | text NOT NULL | Self-describing scrypt hash (`server/auth/password.ts`). Secret |
| `role` | text NOT NULL | `check`: `admin` \| `user` |
| `session_secret` | text NOT NULL | HMAC key this account's session tokens are signed with. Secret |
| `must_change_password` | boolean NOT NULL, default `false` | Temporary-password gate: the session is held at the change form until replaced |
| `active` | boolean NOT NULL, default `true` | `false` blocks sign-in; data stays |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Cascades hanging off an account: `account_link_codes`, `web_threads` (and
their transcripts), `tool_connections` it owns. `assistants.owner_account_id`
is set null instead — an assistant outlives its owner.

### `account_link_codes`

One-time self-link codes: a signed-in account mints one in its profile and
sends it to any connected bot; the ingest recognizes it and links that
platform identity to the account in the person-link graph. Minting a new code
retires the account's unused ones.

| Column | Type | Notes |
| --- | --- | --- |
| `code` | text PK | The code verbatim (`link-xxxxxxxx`), matched against message text |
| `account_id` | text NOT NULL → `accounts.id` CASCADE | |
| `created_at` | timestamptz NOT NULL | |
| `expires_at` | timestamptz NOT NULL | Short-lived |
| `used_at` | timestamptz | Single-use; set on redemption |

Index: `account_link_codes_account_idx (account_id)`.

### `person_links`

The declaration that identities across sources are one human ("tg user X =
web user Y"). One row is one person; memory reads resolve a ref through its
link group and read every member's document, so knowledge follows the person
across sources. Unlinked users stay separate.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `note` | text | Operator's free-text note about who this person is |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

### `person_link_members`

One member identity of a link.

| Column | Type | Notes |
| --- | --- | --- |
| `link_id` | text NOT NULL → `person_links.id` CASCADE | Membership dies with the link |
| `user_ref` | text NOT NULL | Scoped user ref (`tg:user:123`, `chat:user:<accountId>`) |
| `created_at` | timestamptz NOT NULL | |

PK `(link_id, user_ref)`; unique `person_link_members_ref_idx (user_ref)` — a
ref belongs to at most one link, which keeps resolution a lookup rather than a
graph walk.

---

## Assistants, transports and connections

### `assistants`

The first-class entity that replaced personalities. Many assistants share one
brain (settings, memory, tools); per assistant: the persona, transport
connections, tool-connection selection and standing tasks. A fresh install
starts with none; the first is created on the Assistants page (the v1 import
that once seeded them was deleted on 2026-09-01 — production starts fresh).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `name` | text NOT NULL | Display name; unique case-insensitively, enforced in the service |
| `persona` | text NOT NULL, default `''` | Persona instructions appended to the base system prompt |
| `owner_account_id` | text → `accounts.id` SET NULL | The owning account: a sender holds owner rights in a turn iff their linked account is this one (admins hold them everywhere). Null only for rows created while auth was unconfigured — admin-owned in effect |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Index: `assistants_name_idx (name)`. Cascades: `assistant_transports`,
`assistant_tool_connections`, `tasks`.

### `transports`

Registered transports. A transport announces itself at boot — id, name, base
URL, MCP path, config-field schemas — and this row is what every core →
transport call resolves against (no per-transport env vars). See
[Adding a transport](../development/adding-a-transport.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | The source id (`tg`) |
| `name` | text NOT NULL | Human name (`Telegram`) |
| `base_url` | text NOT NULL | The transport's announced internal API base URL |
| `mcp_path` | text | Path of the transport's MCP server on that base, or null when none |
| `connection_config_schema` | jsonb `TransportConfigField[]` NOT NULL, default `[]` | Field descriptors for the per-assistant connection section the dashboard renders |
| `transport_config_schema` | jsonb `TransportConfigField[]` NOT NULL, default `[]` | Field descriptors for the transport-level settings section |
| `config` | jsonb NOT NULL, default `{}` | The transport-level opaque config blob; the core never interprets it |
| `enabled` | boolean NOT NULL, default `true` | Admin switch: a disabled transport's events are ignored and it gets no state |
| `registered_at` | timestamptz NOT NULL | |
| `last_seen_at` | timestamptz NOT NULL | Stamped on every registration/heartbeat — the reachability signal |
| `updated_at` | timestamptz NOT NULL | |

### `assistant_transports`

Per-assistant transport connections: one opaque config section per transport
(a Telegram section holds the bot token). This is **desired** state — the
transport fetches it at boot and on change events and reconciles; actual
state is published on the bus, not stored.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `assistant_id` | text NOT NULL → `assistants.id` CASCADE | |
| `transport` | text NOT NULL | The owning transport's id (`transports.id` as a plain string, no FK) |
| `config` | jsonb NOT NULL, default `{}` | The opaque connection config; validated only by the transport's announced schema |
| `enabled` | boolean NOT NULL, default `true` | Whether this connection should run |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Unique `assistant_transports_idx (assistant_id, transport)`.

---

## Settings and backends

### `backends`

The operator's catalog of OpenAI-compatible endpoints. See
[Backends](../features/backends.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `name` | text NOT NULL | Display name; unique case-insensitively, enforced in the service |
| `base_url` | text NOT NULL | Base URL of the endpoint (e.g. `.../v1`) |
| `api_key` | text | Secret; never returned in plaintext |
| `type` | text NOT NULL, default `openai-compatible` | Which inference server answers at `base_url` (`lib/llm-backend.ts`) |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Index: `backends_name_idx (name)`. Every `settings.*_backend_id` references
this table with `ON DELETE RESTRICT` — a backend in use cannot be deleted out
from under a role.

### `settings`

One row, `id = 'singleton'`, enforced by the `settings_singleton` check. New
settings are added as typed columns with defaults plus a migration; the
repository always reads and writes the one row. See
[Settings](../features/settings.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK, default `'singleton'` | |
| `chat_backend_id`, `model` | text → `backends.id` RESTRICT / text | The chat (main) role: which backend every reply runs on, and the model |
| `tavily_api_key` | text | Secret; the web-search tool's API key |
| `embedding_backend_id`, `embedding_model` | text | Null backend uses the chat backend; null model turns embeddings off. The model must emit `EMBEDDING_DIMENSIONS`-wide vectors |
| `image_backend_id`, `image_model` | text | Same shape; null model disables the image tool |
| `speech_backend_id`, `speech_model`, `speech_voice` | text | Same shape; null model disables voice replies; null voice uses the endpoint default |
| `audio_backend_id`, `audio_model` | text | Same shape; null model falls back to the chat model |
| `audio_transcription_mode` | text NOT NULL, default `transcriptions` | `transcriptions` (the STT endpoint) \| `chat` (chat `input_audio`); typed in the schema, no `check` |
| `vision_backend_id`, `vision_model` | text | Same shape; null halves fall back to the chat backend/model |
| `classifier_backend_id`, `classifier_model` | text | Same shape; the per-message checks (addressing, honesty, rules) |
| `background_backend_id`, `background_model` | text | Same shape; the offline jobs (summaries, memory, insights, reflection) |
| `browser_backend_id`, `browser_model` | text | Same shape; the browser agent |
| `maintenance_mode_enabled` | boolean NOT NULL, default `false` | Only the owner can trigger LLM replies |
| `assistant_loop_guard_turns` | integer NOT NULL, default `3` | Bot-to-bot loop guard (user decision, 2026-08-24): assistant-authored turns a chat may hold in a row before every assistant there falls silent until a human speaks. Deterministic; `0` stops assistants answering each other at all |
| `timezone` | text NOT NULL, default `UTC` | IANA name; the operator timezone |
| `daily_jobs_run_time` | text NOT NULL, default `04:00` | Local `HH:MM` the daily background jobs run at |
| `browser_download_limit_gb` | integer NOT NULL, default `10` | Hard ceiling on a single browser-agent download |
| `updated_at` | timestamptz NOT NULL | |

Gone from this table, deliberately: `telegram_bot_token` (now
`assistant_transports.config`), `active_personality_id` (assistants are bound
to chats by transport connections), `owner_username` / `owner_user_id`
(per-assistant owner rights through accounts and identity links),
`operator_password_hash` / `session_secret` (the `accounts` table).

---

## Conversation store (`source_*`)

The generalized conversation store (redesign Phase 7): every transport's
users, chats, messages and media in one set of tables, keyed by a `source`
discriminator plus source-local text ids. The former tg store, table for
table, with the Telegram-shaped columns generalized. The core writes here:
its ingest consumer (`server/ingest/consumer.ts`) persists the events
transports forward over the queue, and transports report their sends through
the internal transports API. The web chat's `web_*` tables stay separate (it
is a core feature, not a transport).

### `source_users`

Every person a transport has seen. Upserted passively on every message. See
[Known users and groups](../features/known-users-and-groups.md).

| Column | Type | Notes |
| --- | --- | --- |
| `source` | text NOT NULL | Which transport knows them |
| `user_id` | text NOT NULL | Source-local user id (numeric for Telegram, never assumed so) |
| `username` | text | Platform handle (Telegram `@username`, normalized lowercase), or null |
| `first_name`, `last_name` | text | From the platform |
| `aliases` | text[] NOT NULL, default `{}` | Operator-curated alternate names/nicknames |
| `language` | text | Operator-configured reply language for this user's direct chat |
| `first_seen_at`, `updated_at` | timestamptz NOT NULL | |

PK `(source, user_id)`; index `source_users_username_idx (source, username)`.

### `source_chats`

Every group conversation a transport participates in.

| Column | Type | Notes |
| --- | --- | --- |
| `source` | text NOT NULL | |
| `chat_id` | text NOT NULL | Source-local chat id |
| `title` | text | Group title, refreshed on every message |
| `type` | text | The platform's own chat type string (`group` / `supergroup` / …) |
| `notes` | text | Operator-curated free-text description of the group |
| `language` | text | Operator-configured reply language for this group |
| `first_seen_at`, `updated_at` | timestamptz NOT NULL | |

PK `(source, chat_id)`.

### `source_chat_members`

Chat ↔ user membership — the roster the reply prompt's chat context is built
from. PK `(source, chat_id, user_id)`; columns `first_seen_at`, `last_seen_at`
(timestamptz NOT NULL). Index `source_chat_members_user_idx (source, user_id)`.
No foreign keys: a member row exists because the transport saw the pair.

### `source_chat_assistants`

Which assistants are present in a chat, stamped from what the transport
actually delivered to each connection. The cross-feed and the group fan-out
read it. PK `(source, chat_id, assistant_id)`; columns `first_seen_at`,
`last_seen_at`. `assistant_id` is a plain id, no FK.

### `source_messages`

The 1:1 mirror of every transport conversation — every human message and
every assistant reply. This is the substrate the history window, summaries,
passive memory extraction and the analytics volume charts read.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | Monotonic insertion order; preserved verbatim by the v1 import |
| `source` | text NOT NULL | |
| `chat_id` | text NOT NULL | Source-local chat id |
| `assistant_id` | text | The assistant whose conversation the row belongs to: set on every assistant-authored row and on direct-chat user rows (per-assistant DM streams); null on group user rows — the shared stream |
| `source_message_id` | text NOT NULL | Source-local message id within the chat |
| `dedupe_key` | text NOT NULL | Transport-computed stream identity — the idempotence key (see Conventions) |
| `role` | text NOT NULL | `check`: `user` \| `assistant` |
| `user_id` | text | Sender's source-local user id for `user` rows; null for `assistant` |
| `content` | text NOT NULL | Full message text (or media caption); can be empty for a media-only row |
| `reply_to_source_message_id` | text | Source-local id this message replied to, or null |
| `sent_at` | timestamptz NOT NULL | When the message existed on the platform |
| `edited_at` | timestamptz | Set when a later edit rewrote the content |
| `deleted_at` | timestamptz | Set when the message is known deleted (the bot's own deletions only) |
| `bot_reaction` | text | The bot's own reaction badge on this message (current state, or null) |
| `bot_reacted_at` | timestamptz | When the current `bot_reaction` was set |
| `processed` | boolean NOT NULL, default `true` | Live-processing semaphore — released when the turn settles |
| `created_at` | timestamptz NOT NULL | When we captured the row (may differ from `sent_at`) |

- Unique `source_messages_dedupe_idx (source, dedupe_key)` — re-deliveries
  are no-ops without the core knowing the platform's stream rules.
- `source_messages_chat_sent_idx (source, chat_id, sent_at)` — the history
  window read.
- `source_messages_chat_msg_idx (source, chat_id, source_message_id)` — the
  lookup by source-local id.
- `source_messages_content_trgm_idx` — GIN `gin_trgm_ops` on `content`,
  serving `history_search`'s arbitrary-substring `ILIKE`.

The bot's own reaction badge lives on the message row, state of the message
like `edited_at` (user decision, 2026-08-15: a reaction is a history record,
not a separate table). A platform gives a bot one reaction per message, so
the columns hold the current badge.

### `source_media`

Media attached to a transport message — one row per media-bearing message.
Bytes live in `source_media_blobs` **only while the row is `pending`** and
are dropped once described: the platform is its own archive. See
[Vision](../features/vision.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `source`, `chat_id`, `source_message_id` | text NOT NULL | The message it belongs to (no FK to `source_messages`) |
| `kind` | text NOT NULL | `photo` \| `sticker` \| `image_document` \| `animation` \| `video` \| `voice` (no `check`) |
| `file_id` | text NOT NULL | Source-local file handle (Telegram `file_id`), for re-downloads |
| `file_unique_id` | text | Source-local stable file identity, or null |
| `mime_type` | text | Mime hint of the stored payload |
| `vision_hint` | text | Extra hint for the describer (a sticker's emoji), or null |
| `description` | text | The vision model's description / the voice transcript; null until made |
| `status` | text NOT NULL, default `pending` | `check`: `pending` \| `described` \| `unavailable` |
| `created_at` | timestamptz NOT NULL | |
| `described_at` | timestamptz | Set when a description was produced and the bytes were dropped |

Unique `source_media_chat_msg_idx (source, chat_id, source_message_id)`;
index `source_media_status_idx (status, created_at)` — the backfill job scans
pending rows oldest first.

### `source_media_blobs`

The binary payload of a pending `source_media` row, one row per frame (a
video contributes several sampled frames).

| Column | Type | Notes |
| --- | --- | --- |
| `media_id` | text NOT NULL → `source_media.id` CASCADE | |
| `frame_index` | integer NOT NULL | 0 for a still image / the preview frame |
| `data` | bytea NOT NULL | Normalized payload bytes of this frame |

PK `(media_id, frame_index)`. The repository converts to/from base64 so
callers never handle `Buffer`s.

---

## Web chat (`web_*`)

The web chat is a core feature since the chat dissolve (Phase 6): the former
`apps/chat` store, table for table. Scoped refs `chat:thread:<id>` and
`chat:user:<accountId>` keep naming these rows on events, memory and traces —
`chat` stays a source id even though no separate app serves it. The former
`web_users` table is gone (migration `0010`): the account is its own web-chat
identity.

### `web_threads`

Named threads. Each belongs to one account and is bound to one assistant
**at creation** — no mid-thread switching.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `user_id` | text NOT NULL → `accounts.id` CASCADE | The owning account; threads die with it |
| `assistant_id` | text NOT NULL | The assistant answering in this thread, fixed at creation (plain id, no FK) |
| `name` | text NOT NULL | Auto-generated from the first exchange, or renamed by hand |
| `title_provisional` | boolean NOT NULL, default `false` | True while `name` is the placeholder a new thread starts with; the pipeline names the thread from its first exchange and clears it, and a hand rename clears it too |
| `notes` | text | Operator-curated free-text description of the thread |
| `language` | text | Operator-configured reply language for this thread |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Index: `web_threads_user_idx (user_id)`.

### `web_messages`

The thread transcript: every user message and every assistant reply.
Append-only; the identity id gives insertion order.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `thread_id` | text NOT NULL → `web_threads.id` CASCADE | |
| `role` | text NOT NULL | `check`: `user` \| `assistant` |
| `content` | text NOT NULL | Full message text |
| `sent_at` | timestamptz NOT NULL | |
| `reply_to_message_id` | bigint | The message this one answers, or null |
| `deleted_at` | timestamptz | Soft delete: the outbound port can retract what it sent (a browsing acknowledgement replaced by the real answer). Rows stay so ids never dangle; views skip them |
| `created_at` | timestamptz NOT NULL | |

Index: `web_messages_thread_sent_idx (thread_id, sent_at)`.

### `web_media`

Uploaded media attached to one message (an image upload, a voice note, a
produced file). Same describe lifecycle as `source_media`, with one
deliberate difference: **the bytes stay after describing** — a web thread is
the only archive its pictures have (`features/web-chat/server/media-repository.ts`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `message_id` | bigint NOT NULL → `web_messages.id` CASCADE | |
| `kind` | text NOT NULL | `image` \| `voice` \| `file` (no `check`) |
| `mime_type` | text | |
| `description` | text | The vision model's description / the voice transcript; null until made |
| `status` | text NOT NULL, default `pending` | `check`: `pending` \| `described` \| `unavailable` |
| `created_at` | timestamptz NOT NULL | |
| `described_at` | timestamptz | |

Unique `web_media_message_idx (message_id)` — one media row per message;
index `web_media_status_idx (status, created_at)`.

### `web_media_blobs`

PK `(media_id, frame_index)`, `media_id` → `web_media.id` CASCADE; `data`
bytea NOT NULL (normalized JPEG for images; the original container for
voice). Same shape as `source_media_blobs`.

---

## Memory

See [Memory](../features/memory.md). Every person is keyed by scoped user ref;
person links make a linked person's documents read as one body of memory.

### `memory_entries`

The pending queue. Two producers: the `memory_save` tool mid-reply, and
nightly passive extraction over the mirror. A note becomes memory only once
consolidated; the queue itself is neither injected into prompts nor readable
by tools.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `scope` | text NOT NULL | `check`: `user` \| `general` |
| `user_ref` | text | Scoped ref of the person the fact is about — `user` scope only |
| `content` | text NOT NULL | The durable fact, as the model wrote it |
| `origin_chat_ref` | text | Scoped ref of the chat the note was saved from (provenance, not scope) |
| `created_at` | timestamptz NOT NULL | |

`memory_entries_user_ref_check` enforces `(scope = 'user') = (user_ref is not
null)`: a user note must name its person and a general note must not. Index
`memory_entries_scope_user_idx (scope, user_ref)`.

### `user_memories`

One consolidated document per person.

| Column | Type | Notes |
| --- | --- | --- |
| `user_ref` | text PK | Scoped ref of the person (`tg:user:123`, `chat:user:<accountId>`) |
| `content` | text NOT NULL | The merged memory document — durable facts, one per line |
| `embedding` | vector(1024) | Embedding of `content` for the semantic half of memory search |
| `updated_at` | timestamptz NOT NULL | |

Indexes: `user_memories_embedding_idx` (HNSW, cosine) and the hand-written
`user_memories_content_fts_idx` (GIN on `to_tsvector('simple', content)`) in
migration `0000` — one per half of the hybrid search. No FK — the ref names
a source-owned person.

### `general_memories`

Singleton (`id = 'singleton'`, default). One document of cross-chat shared
knowledge — definitions, rules, conventions — plus facts about people who have
no document of their own (user decision, 2026-07-28, reversing 2026-07-17).
Never searched, always injected in full.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK, default `'singleton'` | |
| `content` | text NOT NULL | Durable facts, one per line |
| `updated_at` | timestamptz NOT NULL | |

---

## Tasks and turn actions

### `tasks`

One standing instruction plus the trigger that runs it — standing rules and
timed jobs unified (user decision, 2026-08-13), now owned by an assistant and
pointing at chats and people through scoped refs. See
[tasks.md](../features/tasks.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `assistant_id` | text NOT NULL → `assistants.id` CASCADE | The assistant this task belongs to; dies with it |
| `chat_ref` | text | Scoped chat ref; **null** means every chat (global). `tasks_scope_check`: null only for `message` / `on-reply` |
| `thread_id` | text | Source-local forum-topic thread to deliver into, or null (chat root) — the platform's own id, verbatim |
| `created_by_user_ref` | text | Scoped ref of whoever created it, or null (dashboard) |
| `source` | text NOT NULL, default `dashboard` | `check`: `chat` \| `dashboard` — where the task was authored |
| `created_by_owner` | boolean NOT NULL, default `false` | Whether the creator held owner rights at creation time, stamped from the inbound event's `sender.isOwner` (the source is authoritative for owner identity). A task lends owner rights when it is dashboard-authored or this flag is set |
| `instruction` | text NOT NULL | The task in the author's own words |
| `context` | text | Background gathered at creation for timed kinds; null otherwise |
| `trigger` | text NOT NULL | `check`: `message` \| `on-reply` \| `interval` \| `timeout` \| `schedule` |
| `target_user_refs` | text[] NOT NULL, default `{}` | Scoped refs of the senders a prompt task applies to; empty = everyone. `tasks_targets_scope_check`: empty unless `chat_ref` is set |
| `every_minutes` | integer | `interval`: minutes between fires |
| `delay_minutes` | integer | `timeout`: minutes after creation (display; the instant is in `next_run_at`) |
| `time_of_day` | text | `schedule`: local `HH:MM` in the operator timezone |
| `weekdays` | integer[] | `schedule` weekly; 0 = Sunday … 6 = Saturday |
| `run_date` | text | `schedule` once; `YYYY-MM-DD` |
| `enabled` | boolean NOT NULL, default `true` | A paused task stays authored but never fires and never enters a prompt |
| `attempts` | integer NOT NULL, default `0` | Consecutive failed fires of a due one-shot; disabled at the cap |
| `recent_deliveries` | jsonb `string[]` NOT NULL, default `[]` | The last few messages fires actually sent, newest first |
| `last_run_at`, `next_run_at` | timestamptz | `next_run_at` is null for prompt kinds and spent rows |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Indexes: `tasks_chat_idx (chat_ref, enabled)` — every reply reads one chat's
enabled prompt tasks plus the global ones — and `tasks_due_idx (enabled,
next_run_at)` — the poller's scan. Bounds and duplicate rules are enforced by
the zod contract and the service; scope is not editable (a task moves chats
only by being deleted and recreated).

### `turn_actions`

Actions-started markers — the turn-failure rule's mechanical half (user
decision, 2026-08-22: queue jobs run with `attempts: 1`; the turn runner alone
decides re-enqueue). A row appears the moment a turn performs its first
outward action (a send, a tool execution) and is deleted when the turn settles
terminally. A failed queue job re-enqueues only when no row exists for its
correlation id — transient failures before any work never drop messages, and
nothing double-sends or double-executes.

| Column | Type | Notes |
| --- | --- | --- |
| `correlation_id` | text PK | The turn's correlation id, `<chatId>:<sourceMessageId>:<assistantId>` (`turnCorrelationId` in `packages/contracts/src/source-events.ts`) |
| `acted_at` | timestamptz NOT NULL | |

Written with plain SQL from `server/turn/actions.ts` (`INSERT … ON CONFLICT
DO NOTHING`).

---

## Tool connections

The operator's catalog of remote MCP servers whose tools the model may call
(see [LLM and MCP](llm-and-mcp.md)). Three scope dimensions decide whether a
connection's tools reach a turn (user decision, 2026-08-28): global (the
default), app (`app_scope` names one source app) and assistant
(`all_assistants`, else the explicit selection in
`assistant_tool_connections`). Per-chat and per-user scoping is not part of v2.

### `tool_connections`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `slug` | text NOT NULL | Tool-name prefix and stable handle (`<slug>__<tool>`); unique `tool_connections_slug_idx` |
| `name` | text NOT NULL | Display name |
| `transport` | text NOT NULL, default `http` | `check`: `http` \| `stdio`. Only `http` (Streamable HTTP, legacy SSE fallback) is executed; `stdio` is modeled and refused by the service |
| `endpoint_url` | text NOT NULL | Endpoint of the remote MCP server |
| `auth_headers` | jsonb `{ name: value }` NOT NULL, default `{}` | Sent on every request. Secret — values are never returned |
| `enabled` | boolean NOT NULL, default `true` | Disabled connections keep their snapshot but are offered to nobody |
| `app_scope` | text | Null = every source; else the source app id whose turns may call it |
| `all_assistants` | boolean NOT NULL, default `true` | False = only the assistants listed in `assistant_tool_connections` |
| `managed` | boolean NOT NULL, default `false` | Auto-provisioned by the core (a source app's own MCP server): reconciled from configuration; the operator may enable/scope but not delete or re-point it |
| `owner_account_id` | text → `accounts.id` CASCADE | The owning account (Phase 9); null for managed/system rows. A connection whose owner's current role is `user` may scope only to that account's assistants and target public addresses only |
| `last_discovered_at` | timestamptz | Last successful discovery |
| `last_error` | text | The last failure's message, if any |
| `last_discovered_tools` | jsonb `{ name, description, inputSchema }[]` | What the last discovery **saw** — reviewed against the applied snapshot; null until a first discovery runs |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

### `tool_connection_tools`

The applied tool snapshot of one connection — what the model is actually
offered. Discovery never writes here; only an operator's apply does (user
decision, 2026-08-28), which keeps the prompt's tool block stable across a
conversation.

| Column | Type | Notes |
| --- | --- | --- |
| `connection_id` | text NOT NULL → `tool_connections.id` CASCADE | |
| `name` | text NOT NULL | Remote tool name, unprefixed as the server reports it |
| `description` | text | |
| `input_schema` | jsonb NOT NULL | JSON Schema of the tool's arguments, as discovered |
| `applied_at` | timestamptz NOT NULL | |

PK `(connection_id, name)`.

### `assistant_tool_connections`

Which assistants may call a connection whose `all_assistants` is false.
Absent rows then mean "no assistant" — an explicit empty selection, not a
fallback to everyone. `assistant_id` → `assistants.id` CASCADE,
`connection_id` → `tool_connections.id` CASCADE; PK `(connection_id,
assistant_id)`.

---

## Self-improvement

See [Self-improvement](../features/self-improvement.md). Raw feedback is
conversation-derived and sits in the conversation store; the distilled
outputs are keyed by scoped ref.

### `source_feedbacks`

One row per 👍/👎 reaction on an assistant reply, collected through the
transport's follow-up menu. Raw material; the distilled outputs live below.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `source`, `chat_id` | text NOT NULL | |
| `source_message_id` | text NOT NULL | Source-local id of the reacted reply |
| `user_id` | text NOT NULL | Who reacted (source-local user id) |
| `reaction` | text NOT NULL | `check`: `up` \| `down` |
| `feedback` | text | The chosen option's text, or the user's own words; null until answered |
| `status` | text NOT NULL, default `pending` | `check`: `pending` \| `awaiting_text` \| `completed` |
| `topic` | text NOT NULL, default `quality` | `check`: `quality` \| `addressing` |
| `menu_message_id` | text | Source-local id of the options menu message (for edits and reply capture) |
| `model` | text | Clean model name that generated the reacted reply |
| `reflection`, `reflection_model` | text | The bot's own account of the exchange, and the model that wrote it |
| `prefs_version`, `corrections_version` | integer | Which distilled versions incorporated this row; null = not yet |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Unique `source_feedbacks_msg_user_idx (source, chat_id, source_message_id,
user_id)`; indexes `source_feedbacks_status_idx (status)` and
`source_feedbacks_prefs_idx (user_id, prefs_version)` — the daily job's scan
for completed-but-unincorporated rows. A completed feedback also travels the
bus as a `feedback.recorded` event so the learning jobs never poll.

### `communication_preferences`

Versioned per-person preference documents, distilled by the daily job.
Append-only; the latest version for the sender is injected into their replies.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `user_ref` | text NOT NULL | Scoped ref of the person |
| `model` | text NOT NULL | Clean model name that produced this version |
| `likes`, `dislikes` | text NOT NULL | What this person likes / dislikes about the replies |
| `version` | integer NOT NULL | Monotonic per person; the latest wins |
| `created_at` | timestamptz NOT NULL | |

Unique `comm_prefs_user_version_idx (user_ref, version)`.

### `self_corrections`

Versioned global self-correction guidelines, composed into the system prompt
on every reply. Append-only.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `model` | text NOT NULL | |
| `correction` | text NOT NULL | The guidelines |
| `version` | integer NOT NULL | Monotonic global version; the latest wins |
| `created_at` | timestamptz NOT NULL | |

Unique `self_corrections_version_idx (version)`.

### `addressing_exclusions`

Words the addressing analyzer must stop reading as an assistant's name, filed
when someone answers 👎 → "Wasn't talking to you". Bot-wide facts; the
provenance columns are refs and source-local ids with no FKs.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `term` | text NOT NULL | The word verbatim as it appeared |
| `normalized` | text NOT NULL | Case-folded, whitespace-collapsed — what the mechanical check matches. Unique `addressing_exclusions_normalized_idx` |
| `bot_display_name` | text NOT NULL | The name the false match was made against |
| `chat_ref` | text | Scoped ref of the chat the report came from |
| `source_message_id` | text | Source-local id of the reported reply |
| `user_ref` | text | Scoped ref of who reported it |
| `feedback_id` | text | Id of the `source_feedbacks` row that created it (no FK) |
| `created_at` | timestamptz NOT NULL | |

---

## Analytics

Both insight tables hold **LLM-derived** insight only. Message volume and
users are computed live from the conversation store; tokens and model
performance come from the trace files. See
[Analytics](../features/analytics.md). Joined at the Phase 10 cutover as a
fresh start (v1 rows not migrated).

### `chat_hour_insights`

One row per scored chat-**hour** — the base grain of the expensive pass. The
hour is the finest thing the dashboard plots; only hours that hold messages
are scored, and a scored hour is final (rewriting one is an explicit
Regenerate).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `chat_ref` | text NOT NULL | Scoped ref of the chat (`tg:chat:-100…`) — the transport is in the ref |
| `insight_hour` | text NOT NULL | `YYYY-MM-DD HH` wall-clock in the operator timezone |
| `mood_score` | integer NOT NULL | 0 (very negative) – 100 (very positive) |
| `mood_label` | text NOT NULL | Short label (`positive`, `tense`, …) |
| `mood_summary` | text NOT NULL | One-sentence justification |
| `top_topic` | text NOT NULL | The most-discussed topic of the hour |
| `word` | text | The standout word of the hour |
| `message_count` | integer NOT NULL | Messages the hour held when scored |
| `model` | text NOT NULL | Clean model name (informational) |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Unique `chat_hour_insights_chat_hour_idx (chat_ref, insight_hour)`.

### `period_insights`

Hierarchical roll-ups: hour → day → week/month → year → all time. The mood is
a deterministic message-weighted mean of the children; the word and topic are
one cheap LLM pass that *selects* from the children's own words and topics. A
row is written at every granularity an hour touches, `hour` included, so every
mood read is the same query against one table. Always per chat — there is no
global scope.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `granularity` | text NOT NULL | `check`: `hour` \| `day` \| `week` \| `month` \| `year` \| `all` |
| `bucket` | text NOT NULL | `YYYY-MM-DD HH`, `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, or `all` |
| `chat_ref` | text NOT NULL | As in `chat_hour_insights` |
| `word_of_period`, `top_topic` | text NOT NULL | |
| `mood_score` | integer NOT NULL | Message-weighted average 0–100 across the period's hour rows |
| `mood_label` | text NOT NULL | |
| `source_units` | integer NOT NULL | Scored hour rows that fed this roll-up |
| `message_count` | integer NOT NULL | |
| `model` | text NOT NULL | Clean model name that produced the word/topic |
| `computed_at` | timestamptz NOT NULL | |

Unique `period_insights_key_idx (granularity, bucket, chat_ref)`.

### `search_engine_stats`

Scoreboard for the browser agent's search sources — a **live standing, not a
history**: the cascade sorts itself by these counts, so a blocked engine sinks
and a recovering one climbs back. Counts are halved once their total passes a
cap (`features/browser-agent/server/engine-stats.ts`) so the ranking keeps
reacting. The per-search story lives in the run's activity feed and trace.

| Column | Type | Notes |
| --- | --- | --- |
| `engine` | text PK | Source name as the code knows it (`DuckDuckGo`, `Google`, `Bing`, `Tavily`) |
| `successes`, `failures` | integer NOT NULL, default `0` | Attempts that produced usable results / none |
| `last_success_at`, `last_failure_at` | timestamptz | |
| `last_error` | text | Why the last failure failed |
| `updated_at` | timestamptz NOT NULL | |

---

## Browser agent

See [Browser agent](../features/browser-agent.md). Joined at the Phase 10
cutover as a fresh start.

### `browser_agent_runs`

The run row **is** the queue: the runner picks up `queued` rows oldest first,
flips them `running`, and settles them `done` / `failed` with the final
report.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `chat_ref` | text | Scoped ref of the chat the run reports back to, or null for a dashboard-started run (the report is only stored here) |
| `thread_id` | text | Forum-topic thread to deliver into, or null — the platform's own id, verbatim |
| `created_by_user_ref` | text | Scoped ref of whoever asked for the run, or null (dashboard) |
| `is_owner` | boolean NOT NULL, default `false` | Resolved at enqueue time; gates the download tools for the whole run |
| `restricted` | boolean NOT NULL, default `false` | A standing rule drove the run in a group, or lent the sender rights they did not hold: downloads are fenced to `source_urls` and must attach to the chat or be discarded (user decisions, 2026-08-01) |
| `source_urls` | jsonb `string[]` NOT NULL, default `[]` | The triggering message's http(s) URLs, extracted in code — never re-typed by a model |
| `goal` | text NOT NULL | |
| `status` | text NOT NULL, default `queued` | `check`: `queued` \| `running` \| `done` \| `failed` |
| `report`, `error` | text | The agent's final report / the failure reason |
| `steps` | integer NOT NULL, default `0` | Browser actions performed |
| `activity` | jsonb `BrowserAgentStepJson[]` NOT NULL, default `[]` | The ordered activity feed (`tool`, `action`, `url`, `ok`, `summary`, `at`) |
| `downloads` | jsonb `BrowserAgentDownloadJson[]` NOT NULL, default `[]` | Files fetched: `sourceUrl`, `filename`, `sizeBytes`, `deliveredToChat`, `discarded` (`inline` on pre-2026-07-29 rows only) |
| `trace_id` | text | For Debug drill-down |
| `created_at` | timestamptz NOT NULL | |
| `started_at`, `finished_at` | timestamptz | When the runner picked it up / when it settled |

Indexes: `browser_agent_runs_status_idx (status, created_at)` — the runner's
queued scan — and `browser_agent_runs_chat_idx (chat_ref)`.

### `browser_run_screenshots`

Screenshots captured during a run, in capture order. Served to the dashboard
run view; trace events carry only the `(run, seq)` reference — the same "no
base64 in trace JSON" convention vision media follows.

| Column | Type | Notes |
| --- | --- | --- |
| `run_id` | text NOT NULL → `browser_agent_runs.id` CASCADE | |
| `seq` | integer NOT NULL | Capture order within the run, from 0 |
| `url`, `title` | text | Page URL and title at capture time |
| `data` | bytea NOT NULL | JPEG bytes of the viewport |
| `created_at` | timestamptz NOT NULL | |

PK `(run_id, seq)`.

---

## History

See [History](../features/history.md) and
[Background jobs](background-jobs.md).

### `source_message_search`

The searchable projection of one mirrored message — what `history_search`
looks through, as opposed to what the chat literally contains. Built and
embedded by the search-index job.

| Column | Type | Notes |
| --- | --- | --- |
| `source`, `chat_id`, `source_message_id` | text NOT NULL | Composite PK; no FK to `source_messages` |
| `content` | text NOT NULL | The message's own text **plus its media annotation** — the exact string that was embedded |
| `embedding` | vector(1024) | Null when no embedding model is configured |
| `indexed_at` | timestamptz NOT NULL | Staleness clock, compared against the message's `edited_at` and its media's `described_at` |

Two reasons it is a table rather than columns on `source_messages`. A picture
is not its caption: an uncaptioned photo's message row holds `''`, and what it
*shows* lives in `source_media.description` — joining the two here is what
makes a photo, video, GIF, sticker or voice note searchable at all. And the
vector is wide: every reply reads the history window over `source_messages`,
so a 1024-dimensional column there would drag ~4 KB through the hottest read
in the app for a background job's benefit.

Indexes: `source_message_search_embedding_idx` (HNSW, cosine), plus the
hand-written `source_message_search_content_fts_idx` (GIN on
`to_tsvector('simple', content)`) and `source_message_search_content_trgm_idx`
(GIN `gin_trgm_ops`) in migration `0007` — one per half of the hybrid search.

### `source_summaries`

One row per topic distilled from a finished chat-day.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `source`, `chat_id` | text NOT NULL | |
| `summary_date` | text NOT NULL | `YYYY-MM-DD` in the operator timezone |
| `content` | text NOT NULL | A self-contained topic summary |
| `message_ids` | text[] NOT NULL, default `{}` | Source-local message ids this topic came from (the `#<id>` transcript anchors) — how recall leads back to originals. No FK, deliberately |
| `embedding` | vector(1024) | Null when embedding failed or is unconfigured |
| `created_at` | timestamptz NOT NULL | |

Indexes: `source_summaries_chat_date_idx (source, chat_id, summary_date)`;
`source_summaries_embedding_idx` (HNSW, cosine); the hand-written
`source_summaries_content_fts_idx` (GIN on `to_tsvector('simple', content)`)
in migration `0007`.

### `chat_summary_days`

Per-day marker of what the summarization job has covered — core-**job** state,
kept beside the core's other job markers and keyed by scoped chat ref (user
decision, 2026-08-22).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK, identity | |
| `chat_ref` | text NOT NULL | Scoped ref of the chat |
| `summary_date` | text NOT NULL | `YYYY-MM-DD` in the operator timezone |
| `message_count` | integer NOT NULL | Messages the day held when summarized — the re-run trigger |
| `topic_count` | integer NOT NULL | Topics the day distilled into (0 for a day with nothing substantive) |
| `summarized_at` | timestamptz NOT NULL | |

Unique `chat_summary_days_chat_date_idx (chat_ref, summary_date)`. This is
what makes the due-scan idempotent: a day already summarized *at its current
message count* is skipped.

### `memory_extraction_days`

Per-day marker for passive memory extraction: `id` (identity), `chat_ref`,
`extraction_date`, `message_count`, `note_count` (0 for a day of pure noise),
`extracted_at`; unique `memory_extraction_days_chat_date_idx (chat_ref,
extraction_date)`. A deliberate twin of `chat_summary_days` — kept separate so
the two jobs fail, re-run and backfill independently.

---

## What is not in the database

- **Traces.** Append-only monthly NDJSON files, `data/traces/traces-YYYY-MM.ndjson`
  (`server/trace/store.ts`). See [Observability](observability.md).
- **Queues and cross-app events.** Redis holds the BullMQ queues
  (`transport-updates`, `inbound-messages`) and the pub/sub channel
  `assistant-hub-swarm:events`. It is required, but holds no durable domain data
  beyond queued jobs; Compose runs it with AOF persistence under
  `./data/redis`.
- **Browser-agent downloads** (`data/downloads`) and the self-updating tool
  binaries (`data/bin`) — `server/paths.ts`.
- **Live state.** Transport connection status and turn progress are
  published on the bus, not stored; the tables hold desired state
  (`assistant_transports.enabled`) and the reachability stamp
  (`transports.last_seen_at`) only.

---

## Migrations

One chain, `store/migrations/0000` onward — restarted fresh at the Phase 10
cutover (the v1 chain is history). `0000` creates the core store and the
`vector` extension; `0001` adds `turn_actions`; `0004`/`0005` the tool
connections; `0006` the web chat; `0007` the conversation store and
`pg_trgm`; `0008`–`0012` accounts, ownership, link codes and the `web_users`
drop; `0013` the browser agent, analytics and search-engine tables.

```bash
npm run db:generate   # emit SQL from store/schema.ts into store/migrations/
npm run db:migrate    # apply pending migrations to DATABASE_URL
```

Both halves are one job:

- Edit `store/schema.ts`, generate, **and apply**. Generating without applying
  leaves your dev database on the old schema while the code expects the new
  one; fresh Testcontainers hide the gap until a live bot hits it.
- Commit the generated SQL and `store/migrations/meta/`.
- Hand-written SQL belongs in the generated file when drizzle-kit cannot
  express it — the two extensions, the `to_tsvector` expression indexes, data
  moves such as `0010`'s re-pointing of web threads. Each is noted in a
  comment in `store/schema.ts` or the migration itself.
- `drizzle.config.ts` loads `.env*` the way Next does (`@next/env`);
  `db:generate` needs no database, `db:migrate` reads `DATABASE_URL`.

In production the image never ships drizzle-kit. `apps/core/Dockerfile` copies
the SQL files next to `packages/db/migrate/migrate.mjs` — drizzle's
programmatic migrator (`drizzle-orm/node-postgres/migrator`) with its own two
dependencies — and the container command is
`node migrate/migrate.mjs && node apps/core/server.js`: pending migrations
complete before the app accepts traffic, and a failed migration fails the
start. With no `DATABASE_URL` the runner logs a warning and exits 0.
