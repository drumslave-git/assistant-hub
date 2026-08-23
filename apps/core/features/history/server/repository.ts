import "server-only";

/**
 * The history feature's record shapes. The mirror itself lives in the
 * owning source app's store since the source split — reads and writes go
 * through its internal API (`server/source/tg-content.ts`), whose client
 * maps rows back into these v1 shapes so the composition code (transcripts,
 * views, tools) is unchanged. Nothing here touches a database any more.
 */

/** One mirrored message (v1 `chat_messages` row shape). */
export interface ChatMessageRecord {
  /** The store's monotonic insertion id. */
  id: number;
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToMessageId: number | null;
  sentAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  botReaction: string | null;
  createdAt: string;
}

/** Per-chat rollups for the History dashboard overview. */
export interface ChatSummary {
  chatId: string;
  messageCount: number;
  lastSentAt: string;
}
