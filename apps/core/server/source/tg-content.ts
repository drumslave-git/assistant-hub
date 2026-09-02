import "server-only";

import {
  clearSourceMessageIndex,
  countEmbeddedSourceMessages,
  countSourceMessagesNeedingIndex,
  countSourceSummariesByChat,
  getSourceMessageAvailability,
  getSourceMessageSeries,
  getSourceNewUserSeries,
  getSourceTopUsers,
  listSourceChatDayCounts,
  listSourceChatHourCounts,
  listSourceChatSummaries,
  listSourceMessagesNeedingIndex,
  replaceSourceSummariesForDay,
  searchSourceMessagesHybrid,
  searchSourceSummariesHybrid,
  upsertSourceMessageIndex,
  type SourceMessageSearchMatch,
  type SourceSummaryRecord,
} from "@/server/source-store/content";
import {
  appendSourceMessagesBulk,
  getSourceMediaForMessages,
  getSourceMessagesByIds,
  getSourceMessagesInWindow,
  listSourceChatMessages,
} from "@/server/source-store/repository";
import type { SourceMessageRow } from "../../store/schema";
import type { ContentBucketUnit } from "@assistant-hub-swarm/contracts";

/**
 * The conversation content the history/search/summarization/analytics
 * features read and write — served from the core's own conversation store
 * since the Phase 7 de-storing (this module was the HTTP client to the tg
 * app's content API; the interface survived the move, the wire did not).
 *
 * Record shapes keep the v1 numeric `telegramMessageId` the feature
 * composers consume — the content plane is telegram-only by decision
 * (2026-08-27), and telegram ids ARE numeric; the store itself keys by
 * generic text ids.
 */

const SOURCE = "tg" as const;

/** One mirrored message, in the v1 record shape the composers consume. */
export interface SourceChatMessage {
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
  /** The message's media annotation source, or null. */
  media: { kind: string; status: "pending" | "described" | "unavailable"; description: string | null } | null;
}

/** A message search hit (the v1 `MessageSearchMatch` shape). */
export interface SourceMessageMatch extends Omit<SourceChatMessage, "media"> {
  indexedContent: string | null;
  mediaKind: string | null;
  score: number;
}

/** A stored topic summary (the v1 `ChatSummaryRecord` shape). */
export interface SourceSummary {
  id: number;
  chatId: string;
  summaryDate: string;
  content: string;
  messageIds: number[];
  createdAt: string;
  embedded: boolean;
}

export interface SourceSummaryMatch extends SourceSummary {
  score: number;
}

/** A message the indexing job still owes work on. */
export interface SourceUnindexedMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  media: { kind: string; status: string; description: string | null } | null;
}




export interface SourceContentClient {
  /** Specific rows by their source-local ids, visible rows only (v1 by-ids read). */
  messagesByIds(chatId: string, ids: number[]): Promise<SourceChatMessage[]>;
  /** Visible rows in a time window, oldest first (inclusive or day-exclusive end). */
  messagesWindow(
    chatId: string,
    window: { from: Date; to: Date; endExclusive: boolean },
  ): Promise<SourceChatMessage[]>;
  /** The chat's whole mirror as stored, deleted rows flagged (dashboard, export). */
  allMessages(chatId: string): Promise<SourceChatMessage[]>;
  /** The CSV import's write path; rows that already exist are skipped. */
  importMessages(
    chatId: string,
    rows: readonly {
      telegramMessageId: number;
      role: "user" | "assistant";
      userId: string | null;
      content: string;
      replyToMessageId: number | null;
      sentAt: Date;
      editedAt: Date | null;
      deletedAt: Date | null;
    }[],
  ): Promise<number>;
  /** Per-(chat, day) visible message counts before `before` (the day scan's half). */
  dayCounts(timeZone: string, before: string): Promise<{ chatId: string; date: string; messageCount: number }[]>;
  /** Per-bucket message volume + active users (the analytics charts' source). */
  messageSeries(params: {
    fromUtc: Date;
    toUtc: Date;
    unit: ContentBucketUnit;
    timeZone: string;
    chatId?: string | null;
    userId?: string | null;
  }): Promise<{ bucket: string; human: number; bot: number; activeUsers: number }[]>;
  /** Per-bucket first sightings (the Users chart's "new users" line, global). */
  newUserSeries(params: {
    fromUtc: Date;
    toUtc: Date;
    unit: ContentBucketUnit;
    timeZone: string;
  }): Promise<{ bucket: string; newUsers: number }[]>;
  /** The most active human senders in a period (optionally within one chat). */
  topUsers(params: {
    fromUtc: Date;
    toUtc: Date;
    chatId?: string | null;
    limit: number;
  }): Promise<{ userId: string; messages: number }[]>;
  /** Bucket keys in a range holding any message (the period calendar's marks). */
  messageAvailability(params: {
    fromUtc: Date;
    toUtc: Date;
    unit: ContentBucketUnit;
    timeZone: string;
    chatId?: string | null;
  }): Promise<string[]>;
  /**
   * Every (chat, wall-clock hour) pair holding visible messages, with counts
   * — the insight due-scan's source half; the core joins against its own
   * scored rows in JS. `fromUtc` bounds the scan (the floor).
   */
  hourCounts(params: {
    timeZone: string;
    fromUtc?: Date;
  }): Promise<{ chatId: string; insightHour: string; messageCount: number }[]>;
  /** One day's stored topics for a chat (the insight job's extra context). */
  listSummariesForDay(chatId: string, date: string): Promise<SourceSummary[]>;
  /** Replace one day's topics (idempotent); the caller stamps its own marker. */
  replaceSummaries(
    chatId: string,
    summaryDate: string,
    topics: readonly { content: string; messageIds: number[]; embedding: number[] | null }[],
  ): Promise<SourceSummary[]>;
  listSummaries(chatId: string, limit?: number): Promise<SourceSummary[]>;
  summaryCounts(): Promise<Map<string, number>>;
  searchMessages(params: {
    chatId: string | null;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
    filters?: { authorUserIds?: string[]; mediaKinds?: string[] };
  }): Promise<SourceMessageMatch[]>;
  searchSummaries(params: {
    chatId: string;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
  }): Promise<SourceSummaryMatch[]>;
  indexDue(limit: number): Promise<{ messages: SourceUnindexedMessage[]; total: number }>;
  putIndexRows(
    rows: readonly {
      chatId: string;
      telegramMessageId: number;
      content: string;
      embedding: number[] | null;
    }[],
  ): Promise<void>;
  clearIndex(): Promise<number>;
  countEmbedded(chatId: string): Promise<number>;
}


function rowToChatMessage(
  row: SourceMessageRow,
  media: Map<string, { kind: string; description: string | null; status: string }>,
): SourceChatMessage {
  const attached = media.get(row.sourceMessageId) ?? null;
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: Number(row.sourceMessageId),
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.userId,
    content: row.content,
    replyToMessageId:
      row.replyToSourceMessageId != null ? Number(row.replyToSourceMessageId) : null,
    sentAt: row.sentAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    botReaction: row.botReaction,
    createdAt: row.createdAt.toISOString(),
    media: attached
      ? {
          kind: attached.kind,
          status: attached.status as "pending" | "described" | "unavailable",
          description: attached.description,
        }
      : null,
  };
}

async function withMedia(rows: SourceMessageRow[]): Promise<SourceChatMessage[]> {
  const byChat = new Map<string, SourceMessageRow[]>();
  for (const row of rows) {
    const list = byChat.get(row.chatId) ?? [];
    list.push(row);
    byChat.set(row.chatId, list);
  }
  const out: SourceChatMessage[] = [];
  for (const [chatId, chatRows] of byChat) {
    const media = await getSourceMediaForMessages(
      SOURCE,
      chatId,
      chatRows.map((row) => row.sourceMessageId),
    );
    out.push(...chatRows.map((row) => rowToChatMessage(row, media)));
  }
  return out.sort((a, b) => a.id - b.id);
}

function toMatch(match: SourceMessageSearchMatch): SourceMessageMatch {
  return {
    id: match.id,
    chatId: match.chatId,
    telegramMessageId: Number(match.sourceMessageId),
    role: match.role,
    userId: match.userId,
    content: match.content,
    replyToMessageId:
      match.replyToSourceMessageId != null ? Number(match.replyToSourceMessageId) : null,
    sentAt: match.sentAt,
    editedAt: match.editedAt,
    // The pools only ever select visible rows, so a hit is never deleted.
    deletedAt: null,
    botReaction: match.botReaction,
    createdAt: match.createdAt,
    indexedContent: match.indexedContent,
    mediaKind: match.mediaKind,
    score: match.score,
  };
}

function toSummary(record: SourceSummaryRecord): SourceSummary {
  return {
    id: record.id,
    chatId: record.chatId,
    summaryDate: record.summaryDate,
    content: record.content,
    messageIds: record.messageIds.map((id) => Number(id)),
    createdAt: record.createdAt,
    embedded: record.embedded,
  };
}

/** The conversation-store-backed client. Never null since the store moved in. */
export function resolveSourceContent(): SourceContentClient | null {
  return {
    async messagesByIds(chatId, ids) {
      if (ids.length === 0) return [];
      const rows = await getSourceMessagesByIds(
        SOURCE,
        chatId,
        ids.map((id) => String(id)),
      );
      return (await withMedia(rows)).filter((message) => message.deletedAt == null);
    },
    async messagesWindow(chatId, window) {
      const rows = await getSourceMessagesInWindow(SOURCE, chatId, window);
      return (await withMedia(rows)).filter((message) => message.deletedAt == null);
    },
    async allMessages(chatId) {
      return withMedia(await listSourceChatMessages(SOURCE, chatId));
    },
    async importMessages(chatId, rows) {
      return appendSourceMessagesBulk(
        SOURCE,
        rows.map((row) => ({
          chatId,
          sourceMessageId: String(row.telegramMessageId),
          role: row.role,
          userId: row.userId,
          content: row.content,
          replyToSourceMessageId:
            row.replyToMessageId != null ? String(row.replyToMessageId) : null,
          sentAt: row.sentAt,
          editedAt: row.editedAt,
          deletedAt: row.deletedAt,
        })),
      );
    },
    async dayCounts(timeZone, before) {
      return listSourceChatDayCounts(SOURCE, { timeZone, before });
    },
    async messageSeries(params) {
      return getSourceMessageSeries(SOURCE, params);
    },
    async newUserSeries(params) {
      return getSourceNewUserSeries(SOURCE, params);
    },
    async topUsers(params) {
      return getSourceTopUsers(SOURCE, params);
    },
    async messageAvailability(params) {
      return getSourceMessageAvailability(SOURCE, params);
    },
    async hourCounts(params) {
      return listSourceChatHourCounts(SOURCE, params);
    },
    async listSummariesForDay(chatId, date) {
      return (await listSourceChatSummaries(SOURCE, chatId, 200, date)).map(toSummary);
    },
    async replaceSummaries(chatId, summaryDate, topics) {
      const stored = await replaceSourceSummariesForDay(SOURCE, {
        chatId,
        summaryDate,
        topics: topics.map((topic) => ({
          content: topic.content,
          messageIds: topic.messageIds.map((id) => String(id)),
          embedding: topic.embedding,
        })),
      });
      return stored.map(toSummary);
    },
    async listSummaries(chatId, limit = 200) {
      return (await listSourceChatSummaries(SOURCE, chatId, limit)).map(toSummary);
    },
    async summaryCounts() {
      return countSourceSummariesByChat(SOURCE);
    },
    async searchMessages(params) {
      const matches = await searchSourceMessagesHybrid(SOURCE, params);
      return matches.map(toMatch);
    },
    async searchSummaries(params) {
      const matches = await searchSourceSummariesHybrid(SOURCE, params);
      return matches.map((match) => ({ ...toSummary(match), score: match.score }));
    },
    async indexDue(limit) {
      const [messages, total] = await Promise.all([
        listSourceMessagesNeedingIndex(SOURCE, limit),
        countSourceMessagesNeedingIndex(SOURCE),
      ]);
      return {
        messages: messages.map((row) => ({
          chatId: row.chatId,
          telegramMessageId: Number(row.sourceMessageId),
          content: row.content,
          media: row.media,
        })),
        total,
      };
    },
    async putIndexRows(rows) {
      await upsertSourceMessageIndex(
        SOURCE,
        rows.map((row) => ({
          chatId: row.chatId,
          sourceMessageId: String(row.telegramMessageId),
          content: row.content,
          embedding: row.embedding,
        })),
      );
    },
    async clearIndex() {
      return clearSourceMessageIndex(SOURCE);
    },
    async countEmbedded(chatId) {
      return countEmbeddedSourceMessages(SOURCE, chatId);
    },
  };
}

/** The client (kept for callers that word a missing one; never null now). */
export function requireSourceContent(): SourceContentClient {
  const client = resolveSourceContent();
  if (!client) {
    throw new Error("the conversation store is unavailable");
  }
  return client;
}
