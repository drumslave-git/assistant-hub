import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/** Raw binary column. node-postgres maps `bytea` to/from `Buffer` natively. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";

/**
 * Drizzle schema — single source of truth for the database structure.
 *
 * Migrations are generated from this file with `npm run db:generate` (SQL under
 * `db/migrations/`) and applied with `npm run db:migrate` and at server startup.
 * Only shared, cross-feature tables live here; feature-owned tables are added
 * alongside their feature.
 *
 * Ids are generated in application code (`crypto.randomUUID()`), so no
 * database extensions are required. Traces are **not** stored here at all — they
 * live in the file-backed store under `server/trace` (`TRACES_DIR`), and the
 * Analytics dashboard aggregates those files directly. An earlier design mirrored
 * compact per-trace facts into Postgres for the dashboard to query; that was a
 * second source of truth for the same events, and a lossy one, so it is gone.
 */

/**
 * Application settings. A single, typed row (`id = 'singleton'`) holding the
 * operator-configurable, DB-backed configuration (entered via the dashboard,
 * not env vars). New settings are added as typed columns (with a default) plus a
 * migration — the repository always reads/writes the one row.
 */
export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    /** Base URL of the OpenAI-compatible LLM endpoint (e.g. `.../v1`). */
    llmBaseUrl: text("llm_base_url"),
    /** Optional API key for the LLM endpoint. Secret — never returned in plaintext. */
    llmApiKey: text("llm_api_key"),
    /** Selected chat model id (from the endpoint's `/v1/models`). */
    model: text("model"),
    /**
     * The active personality (persona), chosen from the personalities list. Its
     * prompt is composed into the base system prompt on every reply. Null means
     * base prompt only. Cleared automatically (FK `on delete set null`) if the
     * referenced personality is deleted.
     */
    activePersonalityId: text("active_personality_id").references(() => personalities.id, {
      onDelete: "set null",
    }),
    /**
     * Operator dashboard password as a self-describing scrypt hash
     * (`scrypt:N:r:p:<saltB64>:<hashB64>`), set on the first-run `/setup` page
     * (user decision, 2026-07-20 — DB-backed auth, no env credential). Null
     * means auth is not configured yet and the dashboard forces `/setup`.
     * Secret — never returned by any API.
     */
    operatorPasswordHash: text("operator_password_hash"),
    /**
     * HMAC key for session-cookie signing, generated alongside the password
     * hash. Rotating it (a new setup) invalidates every session. Secret.
     */
    sessionSecret: text("session_secret"),
    /** Telegram Bot API token (from @BotFather). Secret — never returned in plaintext. */
    telegramBotToken: text("telegram_bot_token"),
    /** Tavily API key for the web-search MCP tool. Secret — never returned in plaintext. */
    tavilyApiKey: text("tavily_api_key"),
    /**
     * Base URL of the OpenAI-compatible endpoint serving `/v1/embeddings`. Blank
     * means "reuse the LLM connection" — embeddings often run on the same host as
     * chat, but may be served elsewhere.
     */
    embeddingBaseUrl: text("embedding_base_url"),
    /**
     * API key for the embedding endpoint. Secret — never returned in plaintext.
     * Only consulted when {@link embeddingBaseUrl} is set; otherwise the LLM key
     * is used along with the LLM base URL.
     */
    embeddingApiKey: text("embedding_api_key"),
    /**
     * Embedding model id (e.g. `bge-m3`). Must emit vectors of
     * {@link EMBEDDING_DIMENSIONS} components — the width the vector columns are
     * declared at. Null disables every embedding-backed capability (semantic
     * summary search) rather than failing a reply.
     */
    embeddingModel: text("embedding_model"),
    /**
     * Base URL of the OpenAI-compatible endpoint serving `/v1/images/generations`.
     * Blank means "reuse the LLM connection" — image generation is often served by
     * a different host than chat (a diffusion model rarely lives beside the LLM),
     * but need not be.
     */
    imageBaseUrl: text("image_base_url"),
    /**
     * API key for the image endpoint. Secret — never returned in plaintext. Only
     * consulted when {@link imageBaseUrl} is set; otherwise the LLM key is used
     * along with the LLM base URL.
     */
    imageApiKey: text("image_api_key"),
    /**
     * Image generation model id. Null disables the `image_generate` tool rather
     * than failing a reply — the same "degrade, don't guess a model id" rule
     * {@link embeddingModel} follows.
     */
    imageModel: text("image_model"),
    /**
     * Base URL of the OpenAI-compatible endpoint serving `/v1/audio/speech`
     * (voice replies). Blank means "reuse the LLM connection".
     */
    speechBaseUrl: text("speech_base_url"),
    /**
     * API key for the speech endpoint. Secret — never returned in plaintext. Only
     * consulted when {@link speechBaseUrl} is set; otherwise the LLM key is used
     * along with the LLM base URL.
     */
    speechApiKey: text("speech_api_key"),
    /**
     * Speech (TTS) model id. Null disables voice replies rather than failing a
     * reply — the same "degrade, don't guess a model id" rule
     * {@link embeddingModel} follows. Voice messages are still understood
     * (transcription rides the chat model); only the spoken answer needs this.
     */
    speechModel: text("speech_model"),
    /** Voice name for the speech endpoint (e.g. `alloy`). Null → endpoint default. */
    speechVoice: text("speech_voice"),
    /**
     * Base URL of the OpenAI-compatible endpoint serving `/v1/audio/transcriptions`
     * (a whisper-class STT server). Blank means "reuse the LLM connection".
     */
    transcriptionBaseUrl: text("transcription_base_url"),
    /**
     * API key for the transcription endpoint. Secret — never returned in
     * plaintext. Only consulted when {@link transcriptionBaseUrl} is set;
     * otherwise the LLM key is used along with the LLM base URL.
     */
    transcriptionApiKey: text("transcription_api_key"),
    /**
     * Transcription (STT) model id. When set, voice messages are transcribed on
     * the dedicated `/v1/audio/transcriptions` endpoint; when null, transcription
     * falls back to the chat model via an `input_audio` content part (which then
     * requires an audio-capable chat model).
     */
    transcriptionModel: text("transcription_model"),
    /** Bot owner's Telegram @username (normalized: lowercase, no leading `@`). */
    ownerUsername: text("owner_username"),
    /**
     * Owner's numeric Telegram user id, resolved and persisted the first time the
     * configured @username messages the bot (Telegram has no lookup by username).
     */
    ownerUserId: text("owner_user_id"),
    /**
     * Maintenance mode. When on, only the owner can trigger LLM replies, and in
     * groups the owner must @mention the bot directly.
     */
    maintenanceModeEnabled: boolean("maintenance_mode_enabled").notNull().default(false),
    /**
     * Operator timezone (IANA name, e.g. `Europe/Berlin`) for wall-clock features
     * like scheduled tasks — a task at "09:00 daily" fires at 09:00 in this zone.
     * Captured onto each task at creation. Defaults to `UTC`.
     */
    timezone: text("timezone").notNull().default("UTC"),
    /**
     * Local wall-clock time (`HH:MM`, 24-hour, in `timezone`) at which the **daily
     * background jobs** run — self-improvement (distilling user feedback into
     * preferences and corrections) and history summarization (compressing each
     * finished chat-day into embedded topic summaries), plus any future nightly
     * job.
     *
     * One setting for all of them, deliberately (user decision): they are all
     * "run overnight while nobody is talking to the bot", and an operator moving
     * that window means it for every job, not one at a time.
     */
    dailyJobsRunTime: text("daily_jobs_run_time").notNull().default("04:00"),
    /**
     * Largest downloaded file (in MB) the browser agent also attaches to the
     * chat; bigger files stay in the downloads folder and are reported by name.
     * Bounded 1–50 (Telegram's bot upload ceiling). MVP-parity default: 20.
     */
    browserDownloadMaxMb: integer("browser_download_max_mb").notNull().default(20),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type SettingsRow = typeof settings.$inferSelect;
export type SettingsInsert = typeof settings.$inferInsert;

/**
 * Named personalities (personas). Each holds a prompt appended to the base system
 * prompt; the operator manages them on the Personalities page and picks the
 * active one (`settings.active_personality_id`). Names are unique
 * case-insensitively (enforced in the service). Ids are app-generated UUIDs.
 */
export const personalities = pgTable(
  "personalities",
  {
    id: text("id").primaryKey(),
    /** Display name (unique case-insensitively). */
    name: text("name").notNull(),
    /** Persona instructions appended to the base system prompt. */
    prompt: text("prompt").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("personalities_name_idx").on(t.name)],
);

export type PersonalityRow = typeof personalities.$inferSelect;
export type PersonalityInsert = typeof personalities.$inferInsert;

/**
 * Every Telegram user who has messaged the bot. Upserted (by numeric `user_id`)
 * on each incoming message so the operator can see who talks to the bot and pick
 * the owner from a concrete list. Telegram profile fields (`username`, names) are
 * refreshed on every message; `aliases` is operator-curated and never overwritten
 * by the passive upsert.
 */
export const knownUsers = pgTable(
  "known_users",
  {
    /** Numeric Telegram user id, as a string (ids exceed 2^53 safety). */
    userId: text("user_id").primaryKey(),
    /** Telegram @username (normalized: lowercase, no `@`), or null. */
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Operator-curated alternate names/nicknames. */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    /**
     * Operator-configured reply language for this user's private (DM) chat, as a
     * free-text language name (e.g. `Ukrainian`). Null → the bot replies in the
     * default language. Never touched by the passive profile upsert.
     */
    language: text("language"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("known_users_username_idx").on(t.username)],
);

export type KnownUserRow = typeof knownUsers.$inferSelect;
export type KnownUserInsert = typeof knownUsers.$inferInsert;

/**
 * Every Telegram group/supergroup the bot participates in. Upserted (by numeric
 * `chat_id`) on each incoming group message so the operator can see which groups
 * the bot is in. Telegram profile fields (`title`, `type`) are refreshed on every
 * message; `notes` is operator-curated (a free-text description of the group) and
 * never overwritten by the passive upsert. Mirrors {@link knownUsers}.
 */
export const knownGroups = pgTable("known_groups", {
  /** Numeric Telegram chat id, as a string (supergroup ids exceed 2^31). */
  chatId: text("chat_id").primaryKey(),
  /** Group title, refreshed on every message. */
  title: text("title"),
  /** Telegram chat type (`group` or `supergroup`). */
  type: text("type"),
  /** Operator-curated free-text description of the group. */
  notes: text("notes"),
  /**
   * Operator-configured reply language for this group, as a free-text language
   * name (e.g. `Ukrainian`). Null → the bot replies in the default language.
   * Never touched by the passive profile upsert.
   */
  language: text("language"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnownGroupRow = typeof knownGroups.$inferSelect;
export type KnownGroupInsert = typeof knownGroups.$inferInsert;

/**
 * Group ↔ user membership: which known users have been seen in which known
 * group. A row is recorded (and `last_seen_at` refreshed) whenever a user sends a
 * message in a group, so the roster of a group's participants is available for
 * context injection and the dashboard. The pair `(chat_id, user_id)` is unique.
 */
export const groupMembers = pgTable(
  "group_members",
  {
    /** The group the user was seen in. */
    chatId: text("chat_id")
      .notNull()
      .references(() => knownGroups.chatId, { onDelete: "cascade" }),
    /** The known user seen in the group. */
    userId: text("user_id")
      .notNull()
      .references(() => knownUsers.userId, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index("group_members_chat_idx").on(t.chatId),
    index("group_members_user_idx").on(t.userId),
  ],
);

export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type GroupMemberInsert = typeof groupMembers.$inferInsert;

/**
 * A 1:1 mirror of the Telegram conversation: every human message and every bot
 * reply, keyed by chat. Rows are captured passively on each incoming message (so
 * un-addressed group chatter is kept for context) and injected as prior turns
 * into the LLM request for the current day.
 *
 * This is an append-only log, so its primary key is a monotonic identity `id`
 * (extension-free, gives natural insertion order) rather than the app-UUID
 * convention used by entity tables. Uniqueness is on `(chat_id, telegram_message_id)`
 * so `edited_message` updates locate and rewrite the exact stored row.
 *
 * Note: Telegram's Bot API delivers `message` and `edited_message` but has no
 * deletion update for ordinary chats — a bot cannot observe user-initiated
 * deletions there. `deleted_at` exists so the mirror can represent deletions we
 * *can* know about (the bot's own deletions, or Business-connection delete
 * events); it is not populated by ordinary user deletions.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    /** Monotonic insertion order + PK. Append-only log — identity, not a UUID. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id, as a string (supergroup ids exceed 2^31). */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` within the chat (unique per chat). */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** `user` (a human) or `assistant` (the bot's reply). */
    role: text("role").notNull(),
    /** Sender's numeric Telegram user id for `user` rows; null for `assistant`. */
    userId: text("user_id"),
    /** Full message text (or media caption). */
    content: text("content").notNull(),
    /** Telegram `message_id` this message replied to, or null when not a reply. */
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }),
    /** When the message existed in Telegram (`message.date`) — the mirror's clock. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Set when a later `edited_message` update rewrote the content. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Set when the message is known to be deleted (see table note). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Live-processing semaphore: `false` while the reply pipeline is still
     * working on this message, flipped to `true` when it settles (in a
     * `finally`, so every exit path releases it). The vision backfill only
     * touches media whose message is released — or whose hold has clearly
     * expired (a crashed pipeline must not hide a row forever) — so a background
     * describe can never race the live pass. Non-live writers (imports,
     * restores, assistant mirrors) default to `true`: they were never "in
     * flight".
     */
    processed: boolean("processed").notNull().default(true),
    /** When we captured the row (may differ from `sent_at`). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_messages_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    index("chat_messages_chat_sent_idx").on(t.chatId, t.sentAt),
    // Serves history_search's arbitrary-substring ILIKE; without it every query
    // is a sequential scan over the chat's full mirror. Needs `pg_trgm` (enabled
    // in the migration by hand — drizzle-kit emits only the index).
    index("chat_messages_content_trgm_idx").using("gin", sql`${t.content} gin_trgm_ops`),
    check("chat_messages_role_check", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;

/**
 * One topic discussed in one chat on one day, as distilled by the daily
 * summarization job — the long-term half of history recall. The 24-hour window
 * injected into every reply covers *today*; anything older is found by searching
 * these summaries semantically (vector) and lexically (full text), then reading
 * the exact original messages via `message_ids`.
 *
 * A day's rows are replaced wholesale on each summarization of that day, so a
 * re-run is idempotent. `message_ids` holds Telegram message ids (the same
 * `#<id>` anchors the transcript uses), not `chat_messages.id`.
 */
export const chatSummaries = pgTable(
  "chat_summaries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id this topic belongs to. */
    chatId: text("chat_id").notNull(),
    /** The summarized day (`YYYY-MM-DD`), as a wall-clock date in the operator timezone. */
    summaryDate: text("summary_date").notNull(),
    /** Self-contained summary of the topic: what was discussed, decisions, who was involved. */
    content: text("content").notNull(),
    /** Telegram message ids belonging to this topic, for reading the originals. */
    messageIds: bigint("message_ids", { mode: "number" }).array().notNull().default([]),
    /** Embedding of `content` for semantic recall. Null when embedding failed. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_summaries_chat_date_idx").on(t.chatId, t.summaryDate),
    // Approximate-nearest-neighbour index for cosine similarity — the vector half
    // of the hybrid search. The full-text half uses a GIN index on
    // `to_tsvector('simple', content)`, added in the migration (an expression
    // index has no Drizzle column to hang off).
    index("chat_summaries_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type ChatSummaryRow = typeof chatSummaries.$inferSelect;
export type ChatSummaryInsert = typeof chatSummaries.$inferInsert;

/**
 * Marker of a (chat, day) pair the summarization job has processed — including a
 * day that produced *no* topics (pure noise), which would otherwise be rescanned
 * on every run forever.
 *
 * `message_count` is what makes the job self-healing: the due-scan compares it to
 * the day's live message count, so a day gains new rows later (a CSV import, a
 * late edit) it is summarized again, and an unchanged day is never re-spent on
 * the LLM.
 */
export const chatSummaryDays = pgTable(
  "chat_summary_days",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chatId: text("chat_id").notNull(),
    /** The summarized day (`YYYY-MM-DD`) in the operator timezone. */
    summaryDate: text("summary_date").notNull(),
    /** Messages the day held when it was summarized (the re-run trigger). */
    messageCount: integer("message_count").notNull(),
    /** Topics the day distilled into (0 for a day with nothing substantive). */
    topicCount: integer("topic_count").notNull(),
    summarizedAt: timestamp("summarized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_summary_days_chat_date_idx").on(t.chatId, t.summaryDate)],
);

export type ChatSummaryDayRow = typeof chatSummaryDays.$inferSelect;
export type ChatSummaryDayInsert = typeof chatSummaryDays.$inferInsert;

/**
 * Visual media attached to a Telegram message (photo, sticker, image document,
 * animation/video frame). One row per media-bearing message, keyed the same way
 * as {@link chatMessages} so the two join on `(chat_id, telegram_message_id)`.
 *
 * Lifecycle:
 *  - On ingestion the normalized image bytes land in {@link mediaBlobs} (one row
 *    per frame) with `status = 'pending'` — the raw bytes the vision model reads.
 *  - Once described (immediately for the addressed turn, later via the vision
 *    backfill job for the rest) the model's text description is written to
 *    `description`, the blob rows are deleted, and `status = 'described'`. This
 *    keeps long-term history token-light: past turns carry a text description,
 *    not a megabyte of image bytes.
 *  - Media that cannot be loaded/decoded is `status = 'unavailable'` (no bytes,
 *    an operator-visible reason), so it is neither re-attempted nor lost.
 *
 * Ids are app-generated UUIDs (entity convention).
 */
export const messageMedia = pgTable(
  "message_media",
  {
    id: text("id").primaryKey(),
    /** Telegram chat id, as a string (matches `chat_messages.chat_id`). */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` the media is attached to. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** Media kind: `photo` | `sticker` | `image_document` | `animation` | `video`. */
    kind: text("kind").notNull(),
    /** Telegram `file_id` — lets the backfill job re-download bytes if needed. */
    fileId: text("file_id").notNull(),
    /** Telegram `file_unique_id` (stable across bots), or null. */
    fileUniqueId: text("file_unique_id"),
    /** Mime hint of the stored image (always `image/jpeg` after normalization). */
    mimeType: text("mime_type"),
    /** Extra hint for the describer (e.g. a sticker's emoji), or null. */
    visionHint: text("vision_hint"),
    /** The vision model's text description; null until described. */
    description: text("description"),
    /** `pending` (bytes stored, awaiting description) | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced and the bytes were dropped. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("message_media_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    // Media never floats free: every row belongs to a mirrored chat message
    // (media that was never a Telegram message does not exist). Mirror first,
    // ingest second — a failed mirror now fails the media store loudly instead
    // of leaving an orphan. Cascade: purging a message purges its media.
    foreignKey({
      columns: [t.chatId, t.telegramMessageId],
      foreignColumns: [chatMessages.chatId, chatMessages.telegramMessageId],
      name: "message_media_message_fk",
    }).onDelete("cascade"),
    // Backfill (priority 8) scans for pending rows oldest-first.
    index("message_media_status_idx").on(t.status, t.createdAt),
    check("message_media_status_check", sql`${t.status} in ('pending', 'described', 'unavailable')`),
  ],
);

export type MessageMediaRow = typeof messageMedia.$inferSelect;
export type MessageMediaInsert = typeof messageMedia.$inferInsert;

/**
 * The binary payload of a pending {@link messageMedia} row, one row per frame:
 * a still image is a single row (`frame_index = 0`), a video/GIF is its sampled
 * frames in chronological order. Frame 0 doubles as the dashboard preview.
 *
 * Kept out of `message_media` on purpose: bytes only exist while a row is
 * `pending`, so listing/annotating media never drags TOASTed payloads through a
 * scan, and dropping bytes on describe is a plain `DELETE` instead of rewriting
 * the main row. Stored as real `bytea` — no base64 inflation, no jsonb parsing.
 */
export const mediaBlobs = pgTable(
  "media_blobs",
  {
    /** Owning media row; blobs vanish with it. */
    mediaId: text("media_id")
      .notNull()
      .references(() => messageMedia.id, { onDelete: "cascade" }),
    /** Position in the frame sequence (0 for a still image / the preview frame). */
    frameIndex: integer("frame_index").notNull(),
    /** Normalized JPEG bytes of this frame. */
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.frameIndex] })],
);

export type MediaBlobRow = typeof mediaBlobs.$inferSelect;
export type MediaBlobInsert = typeof mediaBlobs.$inferInsert;

/**
 * A scheduled task: a chat-scoped standing directive ("remind me to call mom at
 * 09:00") that, when its wall-clock schedule comes due, has the LLM generate an
 * in-character message *performing* the directive and posts it to the chat.
 *
 * Schedules are once/daily/weekly at a local `time_of_day`, interpreted at
 * runtime against the single configured operator timezone (`settings.timezone`) —
 * not stored per row, so changing the operator timezone re-times every task.
 * `next_run_at` is the absolute UTC instant of the next firing (all instant
 * columns are `timestamptz`, i.e. stored in UTC) — the poller scans for enabled
 * rows whose `next_run_at` is due, fires them, then advances it (null for a spent
 * one-shot, which also flips `enabled` off). `recent_deliveries` keeps the last
 * few delivered message texts so recurring fires can be told to vary their wording.
 *
 * Tasks are managed by any chat participant (MCP tools, chat-scoped) and by the
 * operator (dashboard). Ids are app-generated UUIDs (entity convention).
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    /** The chat the task belongs to and fires into (Telegram chat id as a string). */
    chatId: text("chat_id").notNull(),
    /** Forum-topic thread to deliver into, or null (delivered to the chat root). */
    threadId: bigint("thread_id", { mode: "number" }),
    /** Numeric Telegram user id of whoever created it, or null (dashboard). */
    createdByUserId: text("created_by_user_id"),
    /** The self-contained directive the fire generates a message from. */
    instruction: text("instruction").notNull(),
    /** `once` | `daily` | `weekly`. */
    scheduleKind: text("schedule_kind").notNull(),
    /** Local time of day as `HH:MM` (24-hour) in `timezone`. */
    timeOfDay: text("time_of_day").notNull(),
    /** Weekdays for `weekly` (0=Sunday..6=Saturday); null otherwise. */
    weekdays: integer("weekdays").array(),
    /** Calendar date for `once` as `YYYY-MM-DD` (in the operator timezone); null otherwise. */
    runDate: text("run_date"),
    /** Whether the task is active (a spent one-shot flips this off). */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Consecutive failed fires of a due one-shot (user decision, 2026-07-20): a
     * one-shot whose fire fails keeps its `next_run_at` and retries on later
     * ticks; at the cap it is disabled — never deleted — so the row stays
     * visible with why it stopped. Reset on any operator update.
     */
    attempts: integer("attempts").notNull().default(0),
    /** The last few delivered message texts, newest first, for wording variation. */
    recentDeliveries: jsonb("recent_deliveries").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** When the task last fired, or null. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Absolute UTC instant of the next firing; null disables the task. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_tasks_chat_idx").on(t.chatId),
    // The poller scans enabled rows ordered by their due instant.
    index("scheduled_tasks_due_idx").on(t.enabled, t.nextRunAt),
    check("scheduled_tasks_schedule_kind_check", sql`${t.scheduleKind} in ('once', 'daily', 'weekly')`),
  ],
);

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type ScheduledTaskInsert = typeof scheduledTasks.$inferInsert;

/**
 * One piece of user feedback on a bot reply, collected via a 👍/👎 reaction and
 * the follow-up menu (5 predefined options + free-text "Other"). Keyed by the
 * reacted **assistant** message — joins {@link chatMessages} on
 * `(chat_id, telegram_message_id)` — and by who reacted, so several users can
 * give feedback on the same reply.
 *
 * Lifecycle: `pending` (reaction seen, menu sent) → `awaiting_text` (user tapped
 * "Other", we await their reply to the menu message) → `completed` (feedback
 * text stored). A repeat reaction reopens/updates the row.
 *
 * `reflection` is the bot's own account of what went right or wrong in the
 * reacted reply and why, written by an LLM pass over the reply's trace plus this
 * feedback (see `features/self-improvement/server/reflect.ts`) and stored on the
 * same row. It is the reasoned half of the feedback — both folds read it.
 *
 * `prefs_version` / `corrections_version` record which
 * {@link usersCommunicationPreferences} / {@link selfCorrections} version
 * incorporated this feedback (null = not yet incorporated) — the daily job scans
 * for the nulls. `model` is the clean model name (e.g. `gemma3:12b`, no registry
 * prefixes) that generated the reply; informational only.
 */
export const usersFeedbacks = pgTable(
  "users_feedbacks",
  {
    id: text("id").primaryKey(),
    /** Telegram chat id, as a string (matches `chat_messages.chat_id`). */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` of the reacted bot reply. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** Who reacted. */
    userId: text("user_id")
      .notNull()
      .references(() => knownUsers.userId, { onDelete: "cascade" }),
    /** `up` (👍) or `down` (👎). */
    reaction: text("reaction").notNull(),
    /** The chosen option text or the user's own words; null until answered. */
    feedback: text("feedback"),
    /** `pending` | `awaiting_text` | `completed`. */
    status: text("status").notNull().default("pending"),
    /**
     * What the feedback is *about*: `quality` (the default — anything said about
     * the reply itself) or `addressing` (the bot answered someone who was not
     * talking to it). The distinction is not cosmetic: an addressing complaint is
     * a routing fault whose fix is an {@link addressingExclusions} row, and
     * folding "you should not have replied" into per-user preferences or the
     * global system prompt would teach style from a mis-fire. The daily job
     * therefore folds `quality` rows only.
     */
    topic: text("topic").notNull().default("quality"),
    /** Telegram `message_id` of the menu we sent (for edits + reply capture). */
    menuMessageId: bigint("menu_message_id", { mode: "number" }),
    /** Clean model name that generated the reacted reply (informational). */
    model: text("model").notNull(),
    /** The bot's self-reflection on the reacted reply; null until it is written. */
    reflection: text("reflection"),
    /** Clean model name that wrote {@link reflection}, or null. */
    reflectionModel: text("reflection_model"),
    /** Preferences version that incorporated this feedback, or null. */
    prefsVersion: integer("prefs_version"),
    /** Self-corrections version that incorporated this feedback, or null. */
    correctionsVersion: integer("corrections_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_feedbacks_msg_user_idx").on(t.chatId, t.telegramMessageId, t.userId),
    index("users_feedbacks_status_idx").on(t.status),
    // The daily job scans completed-but-unincorporated rows per user.
    index("users_feedbacks_prefs_idx").on(t.userId, t.prefsVersion),
    check("users_feedbacks_reaction_check", sql`${t.reaction} in ('up', 'down')`),
    check(
      "users_feedbacks_status_check",
      sql`${t.status} in ('pending', 'awaiting_text', 'completed')`,
    ),
    check("users_feedbacks_topic_check", sql`${t.topic} in ('quality', 'addressing')`),
  ],
);

export type UsersFeedbackRow = typeof usersFeedbacks.$inferSelect;
export type UsersFeedbackInsert = typeof usersFeedbacks.$inferInsert;

/**
 * Versioned per-user communication preferences, distilled by the daily
 * self-improvement job from that user's feedbacks. The latest version per user
 * (max `version`) is injected into the reply prompt as a system context, like
 * the known-user identity block. `model` is the clean model name that performed
 * the distillation; informational only. Append-only — history is kept.
 */
export const usersCommunicationPreferences = pgTable(
  "users_communication_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => knownUsers.userId, { onDelete: "cascade" }),
    /** Clean model name that produced this version (informational). */
    model: text("model").notNull(),
    /** What this user likes about the bot's replies. */
    likes: text("likes").notNull(),
    /** What this user dislikes about the bot's replies. */
    dislikes: text("dislikes").notNull(),
    /** Monotonic version per user; the latest wins. */
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_comm_prefs_user_version_idx").on(t.userId, t.version)],
);

export type UsersCommunicationPreferenceRow = typeof usersCommunicationPreferences.$inferSelect;
export type UsersCommunicationPreferenceInsert =
  typeof usersCommunicationPreferences.$inferInsert;

/**
 * Versioned global self-corrections, distilled by the daily self-improvement job
 * from common complaints/likes across all users' feedbacks. The latest version
 * (max `version`) is composed into the system prompt on every reply, like the
 * personality. `model` is the clean model name that produced the version;
 * informational only. Append-only — history is kept.
 */
export const selfCorrections = pgTable(
  "self_corrections",
  {
    id: text("id").primaryKey(),
    /** Clean model name that produced this version (informational). */
    model: text("model").notNull(),
    /** The correction guidelines composed into the system prompt. */
    correction: text("correction").notNull(),
    /** Monotonic global version; the latest wins. */
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("self_corrections_version_idx").on(t.version)],
);

export type SelfCorrectionRow = typeof selfCorrections.$inferSelect;
export type SelfCorrectionInsert = typeof selfCorrections.$inferInsert;

/**
 * Words the addressing analyzer must stop reading as the bot's display name.
 *
 * The analyzer decides whether an undecided group message calls the bot by name
 * in another alphabet or an inflected form, and it cites the word it took for the
 * name. When that judgment is wrong — a *different* person's name the model
 * thought was a spelling of the bot's — the person who was actually being talked
 * to says so with 👎 → "Wasn't talking to you", and the cited word lands here.
 *
 * Rows apply **bot-wide** (user decision, 2026-07-26): the fact recorded is that
 * this word is not the bot's name, which is true in every chat. `chat_id` /
 * `telegram_message_id` / `user_id` / `feedback_id` are provenance — where the
 * report came from — not scope.
 *
 * Consumed two ways, deliberately: `normalized` is what the *mechanical* check
 * compares an analyzer citation against (an exact, case-folded string equality —
 * no linguistics in code), and `term` is what the analyzer and verifier prompts
 * list so the model can also recognize declined or transliterated forms of an
 * excluded word. The LLM is never skipped on the strength of this list.
 */
export const addressingExclusions = pgTable(
  "addressing_exclusions",
  {
    id: text("id").primaryKey(),
    /** The word verbatim, as it appeared in the message that mis-triggered. */
    term: text("term").notNull(),
    /** Case-folded, whitespace-collapsed form — what the mechanical check matches. */
    normalized: text("normalized").notNull(),
    /** The bot display name the false match was made against (informational). */
    botDisplayName: text("bot_display_name").notNull(),
    /** Chat the report came from (provenance — the exclusion applies bot-wide). */
    chatId: text("chat_id"),
    /** Telegram `message_id` of the bot reply that was reported. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    /** Who reported it; null once that user is forgotten. */
    userId: text("user_id").references(() => knownUsers.userId, { onDelete: "set null" }),
    /** The feedback row that created it, or null when the row is gone. */
    feedbackId: text("feedback_id").references(() => usersFeedbacks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("addressing_exclusions_normalized_idx").on(t.normalized)],
);

export type AddressingExclusionRow = typeof addressingExclusions.$inferSelect;
export type AddressingExclusionInsert = typeof addressingExclusions.$inferInsert;

/**
 * Queue of raw memory notes the model wrote via the `memory_save` tool during a
 * reply, awaiting the nightly consolidation job.
 *
 * The queue exists because a fact must be *saveable mid-conversation* ("remember
 * that I moved to Lisbon") while merging it into long-term memory is an LLM pass
 * too expensive to run inside a reply. A note is therefore appended verbatim here
 * and folded into its scope's durable memory overnight, then deleted.
 *
 * A pending note is NOT part of memory yet (user decision): it is neither injected
 * into replies nor visible to the memory tools, which read consolidated memory
 * only. Nothing is lost by that — a note saved today was said in today's
 * conversation, which the reply already carries verbatim via the 24-hour history
 * window. It also means what a tool returns is exactly what the operator sees
 * stored on the dashboard, with no shadow set of facts in between.
 */
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    /** `user` (a fact about one person) or `general` (shared cross-chat knowledge). */
    scope: text("scope").notNull(),
    /** The person the fact is about — set for `user` scope, null for `general`. */
    userId: text("user_id").references(() => knownUsers.userId, { onDelete: "cascade" }),
    /** The durable fact, as the model wrote it. */
    content: text("content").notNull(),
    /** Chat the note was saved from (provenance for the operator; not a scope). */
    chatId: text("chat_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("memory_entries_scope_check", sql`${t.scope} in ('user', 'general')`),
    // A `user` note must name its person; a `general` note must not.
    check(
      "memory_entries_user_id_check",
      sql`(${t.scope} = 'user') = (${t.userId} is not null)`,
    ),
    index("memory_entries_scope_user_idx").on(t.scope, t.userId),
  ],
);

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;
export type MemoryEntryInsert = typeof memoryEntries.$inferInsert;

/**
 * The consolidated long-term memory of one person — **one merged document per
 * user** (recorded decision), rewritten wholesale by the nightly job as it folds
 * in that user's pending notes: duplicates dropped, contradictions resolved in
 * favour of the newer fact, everything else preserved.
 *
 * A document rather than fact rows because this text is *injected* into replies
 * (for the sender and the other participants of the chat), and a person's memory
 * is read as a whole — the model needs the coherent picture, not the best-matching
 * three lines. The embedding still lets {@link generalMemories}' search tool find
 * a person by a fact about them ("who works at a hospital").
 */
export const userMemories = pgTable(
  "user_memories",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => knownUsers.userId, { onDelete: "cascade" }),
    /** The merged memory document — durable facts, one per line. */
    content: text("content").notNull(),
    /** Embedding of `content` for the semantic half of memory search. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type UserMemoryRow = typeof userMemories.$inferSelect;
export type UserMemoryInsert = typeof userMemories.$inferInsert;

/**
 * Cross-chat shared knowledge — **one merged document**, injected into every
 * reply (operator decision, 2026-07-16), structurally a twin of
 * {@link userMemories} with no person attached.
 *
 * This **reverses** the original design (individually embedded fact rows,
 * retrieved by tool, never injected). That design was built around general memory
 * growing without bound, so a reply could only afford the few facts relevant to
 * the question — which meant each fact needed its own vector. Two things settled
 * it the other way: knowledge the bot has to *think to look up* is knowledge it
 * mostly does not use, and the nightly merge already keeps a document from
 * sprawling by deduplicating and resolving contradictions — exactly as it does
 * for the per-person documents, which have always been injected and uncapped.
 *
 * Consequences, all deliberate: no `embedding` column and no HNSW index (there is
 * nothing to rank — the whole document is always in context); the nightly job runs
 * a *merge* rather than a per-note reconcile; and the memory tools no longer read
 * this scope, since the model can already see it. It is also where a fact about a
 * person the bot cannot key on lands — someone with no {@link knownUsers} row
 * cannot have a per-person document, but "Bob lives in Porto" is still worth
 * knowing, so it is kept here, named.
 *
 * Singleton, like {@link settings}: `id` defaults to `'singleton'`.
 */
export const generalMemories = pgTable("general_memories", {
  id: text("id").primaryKey().default("singleton"),
  /** The merged general-knowledge document — durable facts, one per line. */
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GeneralMemoryRow = typeof generalMemories.$inferSelect;
export type GeneralMemoryInsert = typeof generalMemories.$inferInsert;

/**
 * Marker of a (chat, day) pair the **passive extraction** job has read — including
 * a day that yielded no facts at all, which would otherwise be rescanned forever.
 *
 * Passive extraction exists because {@link memoryEntries} had exactly one producer:
 * the `memory_save` tool, which only runs while the model is generating a reply —
 * and the bot only replies when addressed. In a group that meant the bot learned
 * nothing from the conversation happening around it, which is most of it. The
 * mirror already holds every message regardless of addressing, so the fix is a
 * second producer reading *that* rather than a change to the addressing rules.
 *
 * Structurally a twin of {@link chatSummaryDays}, for the same reasons: extraction
 * is one LLM pass per finished chat-day, and `message_count` is what makes it
 * self-healing — the due-scan compares it to the day's live count, so a day that
 * gains rows later (an import, a late edit) is re-read, while an unchanged day is
 * never re-spent on the LLM.
 *
 * It is a separate marker from `chat_summary_days` rather than a shared "this day
 * was processed" flag: the two jobs ask different questions of the same day and
 * must be able to re-run, fail, and backfill independently of each other.
 */
export const memoryExtractionDays = pgTable(
  "memory_extraction_days",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chatId: text("chat_id").notNull(),
    /** The extracted day (`YYYY-MM-DD`) in the operator timezone. */
    extractionDate: text("extraction_date").notNull(),
    /** Messages the day held when it was extracted (the re-run trigger). */
    messageCount: integer("message_count").notNull(),
    /** Notes the day yielded (0 for a day of pure noise). */
    noteCount: integer("note_count").notNull(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memory_extraction_days_chat_date_idx").on(t.chatId, t.extractionDate)],
);

export type MemoryExtractionDayRow = typeof memoryExtractionDays.$inferSelect;
export type MemoryExtractionDayInsert = typeof memoryExtractionDays.$inferInsert;

/**
 * One chat's LLM-derived analytics insight for one **hour** — the base grain of the
 * analytics feature's expensive pass (mood + top topic + word), computed by the
 * nightly insights job from that hour's transcript (and the existing
 * {@link chatSummaries} for the day it belongs to).
 *
 * The hour is the grain because it is the finest thing the dashboard plots: a
 * day-period chart draws 24 points, so mood has to exist at that resolution or it
 * cannot be shown beside every other metric. Everything coarser — a day's mood, a
 * month's word — is a roll-up of these rows into {@link periodInsights}, never a
 * second reading of the transcript.
 *
 * Only hours that actually hold messages are ever scored, so the cost tracks
 * conversation volume rather than the calendar.
 *
 * A scored hour is final: the job never re-reads it because its message count
 * drifted, which keeps the nightly token spend a function of new conversation and
 * nothing else. Rewriting one is an explicit operator action (Regenerate). The job
 * fails closed — an unusable model response leaves the existing row untouched.
 * `model` is the clean model name (`normalizeModelName`); informational only.
 */
export const chatHourInsights = pgTable(
  "chat_hour_insights",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id this insight belongs to. */
    chatId: text("chat_id").notNull(),
    /** The insight hour (`YYYY-MM-DD HH`) as wall-clock in the operator timezone. */
    insightHour: text("insight_hour").notNull(),
    /** Mood score 0 (very negative) – 100 (very positive) for the hour's conversation. */
    moodScore: integer("mood_score").notNull(),
    /** Short mood label (e.g. `positive`, `tense`). */
    moodLabel: text("mood_label").notNull(),
    /** One-sentence justification of the mood, for the dashboard. */
    moodSummary: text("mood_summary").notNull(),
    /** The single most-discussed topic of the hour, as named by the model. */
    topTopic: text("top_topic").notNull(),
    /** The standout word of the hour, as named by the model. */
    word: text("word"),
    /** Messages the hour held when it was scored. */
    messageCount: integer("message_count").notNull(),
    /** Clean model name that produced this insight (informational). */
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_hour_insights_chat_hour_idx").on(t.chatId, t.insightHour)],
);

export type ChatHourInsightRow = typeof chatHourInsights.$inferSelect;
export type ChatHourInsightInsert = typeof chatHourInsights.$inferInsert;

/**
 * The period roll-up of analytics insight — "word of the period", top topic, and an
 * aggregate mood — for one chat at one granularity.
 *
 * Produced by the same nightly job once the hour rows are fresh: the mood is a
 * message-weighted average of the period's {@link chatHourInsights} (deterministic,
 * so it never depends on a fragile parse), while the word and topic are one cheap
 * LLM pass that *selects* from the hours' own words and topics rather than inventing
 * a new phrase.
 *
 * A row is written at **every** granularity an hour touches, `hour` included — the
 * hour row is a straight copy of its {@link chatHourInsights} score, costing no LLM
 * call. That redundancy is deliberate: it means every mood read, from a day's 24
 * hourly points to the all-time figure, is the same query against one table instead
 * of a special case for the finest grain.
 *
 * Always per chat. A cross-chat average of unrelated conversations is not a mood
 * anybody has, so there is no global scope.
 */
export const periodInsights = pgTable(
  "period_insights",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** `hour` | `day` | `week` | `month` | `year` | `all`. */
    granularity: text("granularity").notNull(),
    /** Bucket key: `YYYY-MM-DD HH`, `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, or `all`. */
    bucket: text("bucket").notNull(),
    /** Telegram chat/group id this roll-up covers. */
    chatId: text("chat_id").notNull(),
    /** The standout word of the period, as named by the model. */
    wordOfPeriod: text("word_of_period").notNull(),
    /** The most-discussed topic across the period, as named by the model. */
    topTopic: text("top_topic").notNull(),
    /** Message-weighted average mood 0–100 across the period's hour rows. */
    moodScore: integer("mood_score").notNull(),
    /** Aggregate mood label. */
    moodLabel: text("mood_label").notNull(),
    /** Scored hour rows that fed this roll-up. */
    sourceUnits: integer("source_units").notNull(),
    /** Messages across the period when it was computed. */
    messageCount: integer("message_count").notNull(),
    /** Clean model name that produced the word/topic (informational). */
    model: text("model").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("period_insights_key_idx").on(t.granularity, t.bucket, t.chatId),
    check(
      "period_insights_granularity_check",
      sql`${t.granularity} in ('hour', 'day', 'week', 'month', 'year', 'all')`,
    ),
  ],
);

export type PeriodInsightRow = typeof periodInsights.$inferSelect;
export type PeriodInsightInsert = typeof periodInsights.$inferInsert;

/**
 * One download completed by a browser-agent run, as stored on the run row.
 * Structural twin of `BrowserDownloadRecord` in `features/browser-agent/types.ts`
 * (jsonb columns cannot import feature types without inverting the dependency).
 */
interface BrowserAgentDownloadJson {
  /** The page the file came from (the link the agent was on). */
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  /** True when the file was small enough to also attach to the chat. */
  inline: boolean;
}

/**
 * One completed action in a run's activity feed (structural twin of
 * `BrowserRunStep` in `features/browser-agent/types.ts`, minus `seq`, which is
 * derived from array order on read).
 */
interface BrowserAgentStepJson {
  tool: string;
  action: string;
  url: string | null;
  ok: boolean;
  summary: string;
  at: string;
}

/**
 * One browser-agent run: a self-contained browsing goal the chat model queued via
 * the `browse_web` tool (or the operator queued from the dashboard), executed in
 * the background by a sub-agent LLM driving the generic browser toolset. The
 * queue is this table — the runner picks up `queued` rows oldest-first, flips
 * them `running`, and settles them `done`/`failed` with the final report.
 *
 * `chat_id` is null for dashboard-started runs: there is no chat to deliver to,
 * so the report is only stored here. `is_owner` is resolved at enqueue time and
 * gates the download tool for the whole run (recorded decision: anyone can start
 * a run; downloads are owner-only). Ids are app-generated UUIDs.
 */
export const browserAgentRuns = pgTable(
  "browser_agent_runs",
  {
    id: text("id").primaryKey(),
    /** Chat the run reports back to, or null for a dashboard-started run. */
    chatId: text("chat_id"),
    /** Forum-topic thread to deliver into, or null (chat root). */
    threadId: bigint("thread_id", { mode: "number" }),
    /** Numeric Telegram user id of whoever asked for the run, or null (dashboard). */
    createdByUserId: text("created_by_user_id"),
    /** Whether the run was started by the owner — gates the download tool. */
    isOwner: boolean("is_owner").notNull().default(false),
    /** The self-contained browsing goal the agent works toward. */
    goal: text("goal").notNull(),
    /** `queued` | `running` | `done` | `failed`. */
    status: text("status").notNull().default("queued"),
    /** The agent's final report (delivered to the chat when one is bound). */
    report: text("report"),
    /** Why the run failed, when `status = 'failed'`. */
    error: text("error"),
    /** Browser actions the agent performed. */
    steps: integer("steps").notNull().default(0),
    /** Ordered activity feed — one entry per completed action (live during a run). */
    activity: jsonb("activity")
      .$type<BrowserAgentStepJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Files downloaded during the run (see {@link BrowserAgentDownloadJson}). */
    downloads: jsonb("downloads")
      .$type<BrowserAgentDownloadJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Trace id of the run's execution trace, for Debug drill-down. */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the runner picked the run up, or null while queued. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the run settled (done/failed), or null. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The runner scans for queued rows oldest-first.
    index("browser_agent_runs_status_idx").on(t.status, t.createdAt),
    index("browser_agent_runs_chat_idx").on(t.chatId),
    check(
      "browser_agent_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

export type BrowserAgentRunRow = typeof browserAgentRuns.$inferSelect;
export type BrowserAgentRunInsert = typeof browserAgentRuns.$inferInsert;

/**
 * Screenshots captured during a browser-agent run, in capture order. The bytes
 * are stored here (JPEG) and served to the dashboard run view; trace events carry
 * only the `(run, seq)` reference — the same "no base64 in trace JSON" convention
 * vision media follows. Rows vanish with their run.
 */
export const browserRunScreenshots = pgTable(
  "browser_run_screenshots",
  {
    /** Owning run. */
    runId: text("run_id")
      .notNull()
      .references(() => browserAgentRuns.id, { onDelete: "cascade" }),
    /** Capture order within the run, starting at 0. */
    seq: integer("seq").notNull(),
    /** Page URL at capture time. */
    url: text("url"),
    /** Page title at capture time. */
    title: text("title"),
    /** JPEG bytes of the viewport screenshot. */
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export type BrowserRunScreenshotRow = typeof browserRunScreenshots.$inferSelect;
export type BrowserRunScreenshotInsert = typeof browserRunScreenshots.$inferInsert;

/**
 * Scoreboard for the browser agent's search sources — one row per engine (plus the
 * API fallback), counting how often each actually returned results. The cascade
 * sorts itself by these numbers, so an engine that starts blocking us sinks and one
 * that recovers climbs back, instead of every search paying a fixed toll for a
 * dead engine ahead of a working one.
 *
 * Deliberately a live scoreboard, not a history: this holds the current standing,
 * and the per-search story is already in the run's activity feed and trace. Counts
 * are halved once their total passes a cap (see `engine-stats.ts`), so the ranking
 * keeps reacting instead of being anchored by ancient results.
 */
export const searchEngineStats = pgTable("search_engine_stats", {
  /** Source name as the code knows it (`DuckDuckGo`, `Google`, `Bing`, `Tavily`). */
  engine: text("engine").primaryKey(),
  /** Attempts that produced usable results. */
  successes: integer("successes").notNull().default(0),
  /** Attempts that produced none — blocked, captcha'd, empty, or errored. */
  failures: integer("failures").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  /** Why the last failure failed — the operator's first clue about an engine. */
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SearchEngineStatRow = typeof searchEngineStats.$inferSelect;

/**
 * Operator-authored bot roles ("specialists"): a named set of instructions the
 * bot takes on per chat, plus a data scope for the entries the shared toolkit
 * stores on its behalf. Authored only on the dashboard (Telegram users activate
 * them, never author them — user decision, 2026-07-27). `data_scope` is
 * `per-chat` (each chat is its own silo) or `shared` (one pool across every chat
 * the specialist is active in). Ids are app-generated UUIDs; three editable seed
 * rows ship in the feature's migration.
 */
export const specialists = pgTable(
  "specialists",
  {
    id: text("id").primaryKey(),
    /** Display name (unique case-insensitively, enforced in the service). */
    name: text("name").notNull(),
    /** What this specialist is for — shown to users by the list tool and the dashboard. */
    description: text("description").notNull().default(""),
    /** Role instructions stacked onto base prompt + active personality when active. */
    instructions: text("instructions").notNull().default(""),
    /** `per-chat` | `shared` — how {@link specialistEntries} are scoped on read. */
    dataScope: text("data_scope").notNull().default("per-chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("specialists_name_idx").on(t.name),
    check("specialists_data_scope_check", sql`${t.dataScope} in ('per-chat', 'shared')`),
  ],
);

export type SpecialistRow = typeof specialists.$inferSelect;
export type SpecialistInsert = typeof specialists.$inferInsert;

/**
 * Which specialist is active in which chat (default: none — no row). One
 * specialist per chat; activation is per chat by design (the active personality
 * stays a single global setting — deliberately different, user decision,
 * 2026-07-27). Deleting a specialist cascades its activations away, returning
 * those chats to the no-specialist default.
 */
export const chatSpecialists = pgTable("chat_specialists", {
  /** Telegram chat id, as a string (a private chat's id equals the user id). */
  chatId: text("chat_id").primaryKey(),
  specialistId: text("specialist_id")
    .notNull()
    .references(() => specialists.id, { onDelete: "cascade" }),
  /** Numeric Telegram user id of who activated it, or null (dashboard). */
  activatedByUserId: text("activated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatSpecialistRow = typeof chatSpecialists.$inferSelect;
export type ChatSpecialistInsert = typeof chatSpecialists.$inferInsert;

/**
 * The single unified store behind the shared specialist data toolkit. No
 * per-specialist tables or schemas: the model picks a free-text `collection`
 * label and decides the JSONB `payload` shape (the skills model — instructions
 * over shared tools; user decision, 2026-07-27). `chat_id` + `author_user_id`
 * are always recorded as provenance; whether reads filter on the chat is the
 * specialist's `data_scope`. Size caps are enforced in the service, and there is
 * no retention/expiry in v1.
 */
export const specialistEntries = pgTable(
  "specialist_entries",
  {
    id: text("id").primaryKey(),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "cascade" }),
    /** The chat the entry was written from (Telegram chat id as a string). */
    chatId: text("chat_id").notNull(),
    /** Numeric Telegram user id of the author, or null (a scheduled fire). */
    authorUserId: text("author_user_id"),
    /** Free-text grouping label the model picks (e.g. `journal`, `groceries`). */
    collection: text("collection").notNull(),
    /** The entry body; shape is decided by the model per collection. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-chat scope reads filter on (specialist, chat); shared scope on specialist alone.
    index("specialist_entries_scope_idx").on(t.specialistId, t.chatId),
    index("specialist_entries_collection_idx").on(t.specialistId, t.collection),
  ],
);

export type SpecialistEntryRow = typeof specialistEntries.$inferSelect;
export type SpecialistEntryInsert = typeof specialistEntries.$inferInsert;
