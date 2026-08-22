import { EMBEDDING_DIMENSIONS } from "@assistant-hub/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
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

/**
 * The v2 **tg store** (PLAN.md, "Data ownership") — everything the Telegram
 * source app owns: users, chats, the message mirror, media, message search,
 * chat summaries, feedbacks collected through Telegram interactions, the
 * telegram connections (bot token per assistant), and this app's own
 * settings (owner identity). Fresh database, fresh migration chain
 * (`store/migrations`), populated from the v1 database by
 * `store/import-v1.ts` at cutover.
 *
 * Table shapes are the v1 tables (known_users, known_groups, chat_messages,
 * …) under clean names — the mirror semantics, id conventions, and every
 * column comment from the v1 schema carry over unchanged. Other apps point
 * at these rows via scoped refs (`tg:user:<user_id>`, `tg:chat:<chat_id>`),
 * never via FKs; `connections.assistant_id` holds a core-store assistant id
 * as a plain string for the same reason.
 */

/** Every Telegram user who has messaged the bot (v1 `known_users`). */
export const users = pgTable(
  "users",
  {
    /** Numeric Telegram user id, as a string (ids exceed 2^53 safety). */
    userId: text("user_id").primaryKey(),
    /** Telegram @username (normalized: lowercase, no `@`), or null. */
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Operator-curated alternate names/nicknames. */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Operator-configured reply language for this user's DM chat. */
    language: text("language"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_username_idx").on(t.username)],
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

/** Every Telegram group/supergroup the bot participates in (v1 `known_groups`). */
export const chats = pgTable("chats", {
  /** Numeric Telegram chat id, as a string (supergroup ids exceed 2^31). */
  chatId: text("chat_id").primaryKey(),
  /** Group title, refreshed on every message. */
  title: text("title"),
  /** Telegram chat type (`group` or `supergroup`). */
  type: text("type"),
  /** Operator-curated free-text description of the group. */
  notes: text("notes"),
  /** Operator-configured reply language for this group. */
  language: text("language"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatRow = typeof chats.$inferSelect;
export type ChatInsert = typeof chats.$inferInsert;

/** Chat ↔ user membership (v1 `group_members`). */
export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.chatId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index("chat_members_chat_idx").on(t.chatId),
    index("chat_members_user_idx").on(t.userId),
  ],
);

export type ChatMemberRow = typeof chatMembers.$inferSelect;
export type ChatMemberInsert = typeof chatMembers.$inferInsert;

/**
 * The 1:1 mirror of the Telegram conversation (v1 `chat_messages`): every
 * human message and every bot reply, keyed by chat. Append-only log —
 * identity id preserves insertion order; uniqueness on
 * `(chat_id, telegram_message_id)` lets edits rewrite the exact row.
 */
export const messages = pgTable(
  "messages",
  {
    /** Monotonic insertion order + PK. Preserved verbatim by the v1 import. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id, as a string. */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` within the chat (unique per chat). */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** `user` (a human) or `assistant` (the bot's reply). */
    role: text("role").notNull(),
    /** Sender's numeric Telegram user id for `user` rows; null for `assistant`. */
    userId: text("user_id"),
    /** Full message text (or media caption). */
    content: text("content").notNull(),
    /** Telegram `message_id` this message replied to, or null. */
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }),
    /** When the message existed in Telegram (`message.date`). */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Set when a later `edited_message` update rewrote the content. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Set when the message is known to be deleted (bot's own deletions only). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** The bot's own reaction badge on this message (current state, or null). */
    botReaction: text("bot_reaction"),
    /** When the current `bot_reaction` was set. */
    botReactedAt: timestamp("bot_reacted_at", { withTimezone: true }),
    /** Live-processing semaphore — see the v1 table note. */
    processed: boolean("processed").notNull().default(true),
    /** When we captured the row (may differ from `sent_at`). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    index("messages_chat_sent_idx").on(t.chatId, t.sentAt),
    // Serves history_search's arbitrary-substring ILIKE (pg_trgm; the GIN
    // expression index is added by hand in the migration).
    index("messages_content_trgm_idx").using("gin", sql`${t.content} gin_trgm_ops`),
    check("messages_role_check", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;

/**
 * The searchable projection of one mirrored message (v1 `chat_message_search`):
 * message text + rendered media annotation, plus its embedding. See the v1
 * schema note for why it is a separate table.
 */
export const messageSearch = pgTable(
  "message_search",
  {
    chatId: text("chat_id").notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** Message text + rendered media annotation — the string that was embedded. */
    content: text("content").notNull(),
    /** Embedding of `content`. Null when no embedding model is configured. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    /** When this row was last (re)built. */
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.telegramMessageId] }),
    foreignKey({
      columns: [t.chatId, t.telegramMessageId],
      foreignColumns: [messages.chatId, messages.telegramMessageId],
      name: "message_search_message_fk",
    }).onDelete("cascade"),
    // FTS + trgm GIN expression indexes are added by hand in the migration.
    index("message_search_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type MessageSearchRow = typeof messageSearch.$inferSelect;
export type MessageSearchInsert = typeof messageSearch.$inferInsert;

/**
 * Visual media attached to a Telegram message (v1 `message_media`). One row
 * per media-bearing message; bytes live in {@link mediaBlobs} while the row
 * is `pending` and are dropped once described.
 */
export const media = pgTable(
  "media",
  {
    id: text("id").primaryKey(),
    /** Telegram chat id, as a string (matches `messages.chat_id`). */
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
    /** `pending` | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced and the bytes were dropped. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_chat_msg_idx").on(t.chatId, t.telegramMessageId),
    foreignKey({
      columns: [t.chatId, t.telegramMessageId],
      foreignColumns: [messages.chatId, messages.telegramMessageId],
      name: "media_message_fk",
    }).onDelete("cascade"),
    index("media_status_idx").on(t.status, t.createdAt),
    check("media_status_check", sql`${t.status} in ('pending', 'described', 'unavailable')`),
  ],
);

export type MediaRow = typeof media.$inferSelect;
export type MediaInsert = typeof media.$inferInsert;

/** The binary payload of a pending {@link media} row, one row per frame (v1 shape). */
export const mediaBlobs = pgTable(
  "media_blobs",
  {
    /** Owning media row; blobs vanish with it. */
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
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
 * One piece of user feedback on a bot reply, collected via a reaction and the
 * follow-up menu (v1 `users_feedbacks`). Telegram-anchored raw material — the
 * distilled outputs (preferences, corrections) live in the core store.
 */
export const feedbacks = pgTable(
  "feedbacks",
  {
    id: text("id").primaryKey(),
    /** Telegram chat id, as a string. */
    chatId: text("chat_id").notNull(),
    /** Telegram `message_id` of the reacted bot reply. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    /** Who reacted. */
    userId: text("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    /** `up` (👍) or `down` (👎). */
    reaction: text("reaction").notNull(),
    /** The chosen option text or the user's own words; null until answered. */
    feedback: text("feedback"),
    /** `pending` | `awaiting_text` | `completed`. */
    status: text("status").notNull().default("pending"),
    /** `quality` or `addressing` — see the v1 table note. */
    topic: text("topic").notNull().default("quality"),
    /** Telegram `message_id` of the menu we sent (for edits + reply capture). */
    menuMessageId: bigint("menu_message_id", { mode: "number" }),
    /** Clean model name that generated the reacted reply (informational). */
    model: text("model").notNull(),
    /** The bot's self-reflection on the reacted reply; null until written. */
    reflection: text("reflection"),
    /** Clean model name that wrote `reflection`, or null. */
    reflectionModel: text("reflection_model"),
    /** Core-store preferences version that incorporated this feedback, or null. */
    prefsVersion: integer("prefs_version"),
    /** Core-store self-corrections version that incorporated this feedback, or null. */
    correctionsVersion: integer("corrections_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feedbacks_msg_user_idx").on(t.chatId, t.telegramMessageId, t.userId),
    index("feedbacks_status_idx").on(t.status),
    index("feedbacks_prefs_idx").on(t.userId, t.prefsVersion),
    check("feedbacks_reaction_check", sql`${t.reaction} in ('up', 'down')`),
    check(
      "feedbacks_status_check",
      sql`${t.status} in ('pending', 'awaiting_text', 'completed')`,
    ),
    check("feedbacks_topic_check", sql`${t.topic} in ('quality', 'addressing')`),
  ],
);

export type FeedbackRow = typeof feedbacks.$inferSelect;
export type FeedbackInsert = typeof feedbacks.$inferInsert;

/**
 * One topic discussed in one chat on one day, distilled by the core's
 * summarization job (v1 `chat_summaries`). Conversation-derived CONTENT, so
 * it lives here with the mirror it summarizes (user decision, 2026-08-22);
 * the core provides the feature and writes/reads through this app's API.
 * The job's coverage markers (which chat-days are done) are core-job state
 * and live in the core store. `message_ids` are Telegram message ids (the
 * `#<id>` transcript anchors), not `messages.id` — no FK, deliberately, as
 * in v1.
 */
export const summaries = pgTable(
  "summaries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id this topic belongs to. */
    chatId: text("chat_id").notNull(),
    /** The summarized day (`YYYY-MM-DD`) in the operator timezone. */
    summaryDate: text("summary_date").notNull(),
    /** Self-contained summary of the topic. */
    content: text("content").notNull(),
    /** Telegram message ids belonging to this topic, for reading the originals. */
    messageIds: bigint("message_ids", { mode: "number" }).array().notNull().default([]),
    /** Embedding of `content` for semantic recall. Null when embedding failed. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("summaries_chat_date_idx").on(t.chatId, t.summaryDate),
    // The full-text half of the hybrid search is a hand-written expression
    // index in the migration (to_tsvector has no Drizzle column to hang off).
    index("summaries_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type SummaryRow = typeof summaries.$inferSelect;
export type SummaryInsert = typeof summaries.$inferInsert;

/**
 * This app's own settings — a single typed row (`id = 'singleton'`), the
 * same convention as the core store's settings. Holds what is Telegram's to
 * decide: the owner identity (user decision, 2026-08-22 — owner logic and
 * settings live on the app side; the core receives the resolved is-owner
 * flag on inbound events, never the raw identity).
 */
export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    /** Owner's Telegram @username (normalized: lowercase, no leading `@`). */
    ownerUsername: text("owner_username"),
    /**
     * Owner's numeric Telegram user id, resolved and persisted the first time
     * the configured @username messages a bot (Telegram has no lookup by
     * username).
     */
    ownerUserId: text("owner_user_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type TgSettingsRow = typeof settings.$inferSelect;
export type TgSettingsInsert = typeof settings.$inferInsert;

/**
 * Telegram connections — one bot token per assistant (PLAN.md). This is the
 * **desired** state the tg app reconciles from (one poller per enabled row);
 * actual state is published on the bus, not stored. `assistant_id` is a
 * core-store assistant id as a plain string (no cross-database FK); the tg
 * app reacts to `assistant.deleted` bus events by removing the row.
 */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    /** The core-store assistant this bot token belongs to. One bot per assistant. */
    assistantId: text("assistant_id").notNull(),
    /** Telegram Bot API token (from @BotFather). Secret — never returned in plaintext. */
    botToken: text("bot_token").notNull(),
    /** Desired state: whether the poller for this bot should run. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connections_assistant_idx").on(t.assistantId)],
);

export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionInsert = typeof connections.$inferInsert;
