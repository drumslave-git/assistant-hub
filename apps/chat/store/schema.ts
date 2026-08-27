import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Raw binary column. node-postgres maps `bytea` to/from `Buffer` natively. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The v2 **chat store** (PLAN.md, "Data ownership") — everything the web-chat
 * source app owns: its own users, named threads (each bound to one assistant
 * at creation), messages, and uploaded media. Fresh database, fresh migration
 * chain; nothing migrates into it from v1 (web chat is new in v2).
 *
 * Shapes mirror the tg store where the pipeline is shared (media +
 * blobs follow the same describe-then-drop lifecycle so the vision pipeline
 * treats both sources alike). Phase 4 (web chat) evolves this via its own
 * migrations as the feature lands.
 */

/**
 * Web-chat users, owned by this app (PLAN.md): the operator gets a chat user
 * bound to their operator session, linkable to other identities via
 * core-store person links like any other pair.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** Display name shown in threads. */
  name: text("name").notNull(),
  /** True for the operator's own chat user (single-operator system). */
  isOperator: boolean("is_operator").notNull().default(false),
  /** Operator-curated alternate names, as in every source's directory. */
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  /** Operator-configured reply language for this person, or null (default). */
  language: text("language"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatUserRow = typeof users.$inferSelect;
export type ChatUserInsert = typeof users.$inferInsert;

/**
 * Named threads. Each belongs to one chat user and is bound to one assistant
 * **at creation** (no mid-thread switching — PLAN.md). `assistant_id` is a
 * core-store assistant id as a plain string (no cross-database FK).
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    /** The chat user who owns the thread; threads die with their user. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The core-store assistant answering in this thread, fixed at creation. */
    assistantId: text("assistant_id").notNull(),
    /** Thread name, chosen by the user. */
    name: text("name").notNull(),
    /** Operator-curated free-text description of the thread, or null. */
    notes: text("notes"),
    /** Operator-configured reply language for this thread, or null (default). */
    language: text("language"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_user_idx").on(t.userId)],
);

export type ThreadRow = typeof threads.$inferSelect;
export type ThreadInsert = typeof threads.$inferInsert;

/**
 * The thread transcript: every user message and every assistant reply.
 * Append-only log — identity id gives natural insertion order.
 */
export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The thread this message belongs to; the transcript dies with it. */
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** `user` (the thread's human) or `assistant` (the bound assistant's reply). */
    role: text("role").notNull(),
    /** Full message text. */
    content: text("content").notNull(),
    /** When the message was sent. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** The message this one answers, or null (unprompted / a fresh turn). */
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }),
    /**
     * Soft delete: the core's outbound port can retract what it sent (a
     * browsing acknowledgement it replaces with the real answer). Rows stay
     * so ids never dangle — the thread view and the listings skip them.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt),
    check("messages_role_check", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type ChatMessageRow = typeof messages.$inferSelect;
export type ChatMessageInsert = typeof messages.$inferInsert;

/**
 * Uploaded media attached to one message (image upload / voice — Phase 4).
 * Same describe-then-drop lifecycle as the tg store's media so the shared
 * vision pipeline treats both sources alike.
 */
export const media = pgTable(
  "media",
  {
    id: text("id").primaryKey(),
    /** The message the media is attached to; media dies with it. */
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Media kind: `image` | `voice` (Phase 4 may extend). */
    kind: text("kind").notNull(),
    /** Mime hint of the stored payload. */
    mimeType: text("mime_type"),
    /** The vision model's text description / the voice transcript; null until made. */
    description: text("description"),
    /** `pending` | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced and the bytes were dropped. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_message_idx").on(t.messageId),
    index("media_status_idx").on(t.status, t.createdAt),
    check("media_status_check", sql`${t.status} in ('pending', 'described', 'unavailable')`),
  ],
);

export type ChatMediaRow = typeof media.$inferSelect;
export type ChatMediaInsert = typeof media.$inferInsert;

/** The binary payload of a pending {@link media} row, one row per frame. */
export const mediaBlobs = pgTable(
  "media_blobs",
  {
    /** Owning media row; blobs vanish with it. */
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    /** Position in the frame sequence (0 for a still image / the preview frame). */
    frameIndex: integer("frame_index").notNull(),
    /** Payload bytes (normalized JPEG for images; original container for voice). */
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.frameIndex] })],
);

export type ChatMediaBlobRow = typeof mediaBlobs.$inferSelect;
export type ChatMediaBlobInsert = typeof mediaBlobs.$inferInsert;
