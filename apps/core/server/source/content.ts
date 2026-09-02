import "server-only";

import {
  parseScopedRef,
  scopedRef,
  type ContentBucketUnit,
  type SourceId,
} from "@assistant-hub-swarm/contracts";

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
  type SourceChatKey,
  type SourceMessageSearchMatch,
  type SourceSummaryRecord,
  type SourceUserKey,
} from "@/server/source-store/content";
import {
  appendSourceMessagesBulk,
  getSourceMediaForMessages,
  getSourceMessagesByIds,
  getSourceMessagesInWindow,
  listSourceChatMessages,
} from "@/server/source-store/repository";
import { listCompatibleTransports } from "@/server/transports/service";
import type { SourceMessageRow } from "../../store/schema";

/**
 * The conversation content the history/search/summarization/analytics
 * features read and write — served from the core's own conversation store
 * since the Phase 7 de-storing, over every registered transport since the
 * open registration.
 *
 * Chats are named by their scoped ref (`tg:chat:-100…`) — the one identity
 * every other surface of the core speaks — and messages by their source-local
 * id as TEXT (a Telegram id is numeric; a Discord snowflake would not survive
 * a `Number()`). A read across chats sees the transports registered on this
 * core's contract major and tags every row with the chat it belongs to; the
 * web chat keeps its own thread store and is not part of this plane.
 */

/** One mirrored message, as the composers consume it. */
export interface SourceChatMessage {
  /** The store's monotonic insertion id. */
  id: number;
  /** Scoped ref of the chat this message belongs to. */
  chatRef: string;
  /** Source-local message id (`#<id>` anchors, trace correlations). */
  sourceMessageId: string;
  role: "user" | "assistant";
  /** Sender's source-local user id for `user` rows; null for the assistant. */
  userId: string | null;
  content: string;
  replyToSourceMessageId: string | null;
  sentAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  botReaction: string | null;
  createdAt: string;
  /** The message's media annotation source, or null. */
  media: {
    kind: string;
    status: "pending" | "described" | "unavailable";
    description: string | null;
  } | null;
}

/** A message search hit. */
export interface SourceMessageMatch extends Omit<SourceChatMessage, "media"> {
  indexedContent: string | null;
  mediaKind: string | null;
  score: number;
}

/** A stored topic summary. */
export interface SourceSummary {
  id: number;
  chatRef: string;
  summaryDate: string;
  content: string;
  /** Source-local ids of the messages the topic distilled. */
  messageIds: string[];
  createdAt: string;
  embedded: boolean;
}

export interface SourceSummaryMatch extends SourceSummary {
  score: number;
}

/** A message the indexing job still owes work on. */
export interface SourceUnindexedMessage {
  chatRef: string;
  sourceMessageId: string;
  content: string;
  media: { kind: string; status: string; description: string | null } | null;
}

/** A (chat, day) bucket's message count. */
export interface SourceChatDay {
  chatRef: string;
  /** `YYYY-MM-DD` in the requested timezone. */
  date: string;
  messageCount: number;
}

export interface SourceContentClient {
  /** Specific rows by their source-local ids, visible rows only. */
  messagesByIds(chatRef: string, ids: readonly string[]): Promise<SourceChatMessage[]>;
  /** Visible rows in a time window, oldest first (inclusive or day-exclusive end). */
  messagesWindow(
    chatRef: string,
    window: { from: Date; to: Date; endExclusive: boolean },
  ): Promise<SourceChatMessage[]>;
  /** The chat's whole mirror as stored, deleted rows flagged (dashboard, export). */
  allMessages(chatRef: string): Promise<SourceChatMessage[]>;
  /** The CSV import's write path; rows that already exist are skipped. */
  importMessages(
    chatRef: string,
    rows: readonly {
      sourceMessageId: string;
      role: "user" | "assistant";
      userId: string | null;
      content: string;
      replyToSourceMessageId: string | null;
      sentAt: Date;
      editedAt: Date | null;
      deletedAt: Date | null;
    }[],
  ): Promise<number>;
  /** Per-(chat, day) visible message counts before `before` (the day scan's half). */
  dayCounts(timeZone: string, before: string): Promise<SourceChatDay[]>;
  /** Per-bucket message volume + active users (the analytics charts' source). */
  messageSeries(params: {
    fromUtc: Date;
    toUtc: Date;
    unit: ContentBucketUnit;
    timeZone: string;
    chatRef?: string | null;
    userRef?: string | null;
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
    chatRef?: string | null;
    limit: number;
  }): Promise<{ userRef: string; messages: number }[]>;
  /** Bucket keys in a range holding any message (the period calendar's marks). */
  messageAvailability(params: {
    fromUtc: Date;
    toUtc: Date;
    unit: ContentBucketUnit;
    timeZone: string;
    chatRef?: string | null;
  }): Promise<string[]>;
  /**
   * Every (chat, wall-clock hour) pair holding visible messages, with counts
   * — the insight due-scan's source half; the core joins against its own
   * scored rows in JS. `fromUtc` bounds the scan (the floor).
   */
  hourCounts(params: {
    timeZone: string;
    fromUtc?: Date;
  }): Promise<{ chatRef: string; insightHour: string; messageCount: number }[]>;
  /** One day's stored topics for a chat (the insight job's extra context). */
  listSummariesForDay(chatRef: string, date: string): Promise<SourceSummary[]>;
  /** Replace one day's topics (idempotent); the caller stamps its own marker. */
  replaceSummaries(
    chatRef: string,
    summaryDate: string,
    topics: readonly { content: string; messageIds: string[]; embedding: number[] | null }[],
  ): Promise<SourceSummary[]>;
  listSummaries(chatRef: string, limit?: number): Promise<SourceSummary[]>;
  /** Stored topic counts keyed by chat ref. */
  summaryCounts(): Promise<Map<string, number>>;
  searchMessages(params: {
    /** One chat, or null for every chat of every registered transport. */
    chatRef: string | null;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
    filters?: { authorUserIds?: string[]; mediaKinds?: string[] };
  }): Promise<SourceMessageMatch[]>;
  searchSummaries(params: {
    chatRef: string;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
  }): Promise<SourceSummaryMatch[]>;
  indexDue(limit: number): Promise<{ messages: SourceUnindexedMessage[]; total: number }>;
  putIndexRows(
    rows: readonly {
      chatRef: string;
      sourceMessageId: string;
      content: string;
      embedding: number[] | null;
    }[],
  ): Promise<void>;
  clearIndex(): Promise<number>;
  countEmbedded(chatRef: string): Promise<number>;
}

/** The sources this plane reads across: every transport on this core's contract major. */
export async function contentSources(): Promise<SourceId[]> {
  return (await listCompatibleTransports()).map((row) => row.id);
}

/** A chat ref as the store keys it. */
export function chatKeyOf(chatRef: string): SourceChatKey {
  const { source, id } = parseScopedRef(chatRef);
  return { source, chatId: id };
}

/** A user ref as the store keys it. */
function userKeyOf(userRef: string): SourceUserKey {
  const { source, id } = parseScopedRef(userRef);
  return { source, userId: id };
}

const chatRefOf = (key: SourceChatKey): string => scopedRef(key.source, "chat", key.chatId);

function rowToChatMessage(
  chatRef: string,
  row: SourceMessageRow,
  media: Map<string, { kind: string; description: string | null; status: string }>,
): SourceChatMessage {
  const attached = media.get(row.sourceMessageId) ?? null;
  return {
    id: row.id,
    chatRef,
    sourceMessageId: row.sourceMessageId,
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.userId,
    content: row.content,
    replyToSourceMessageId: row.replyToSourceMessageId,
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

/** One chat's rows with their media annotations, in store order. */
async function withMedia(chat: SourceChatKey, rows: SourceMessageRow[]): Promise<SourceChatMessage[]> {
  if (rows.length === 0) return [];
  const media = await getSourceMediaForMessages(
    chat.source,
    chat.chatId,
    rows.map((row) => row.sourceMessageId),
  );
  const chatRef = chatRefOf(chat);
  return rows.map((row) => rowToChatMessage(chatRef, row, media)).sort((a, b) => a.id - b.id);
}

function toMatch(match: SourceMessageSearchMatch): SourceMessageMatch {
  return {
    id: match.id,
    chatRef: scopedRef(match.source, "chat", match.chatId),
    sourceMessageId: match.sourceMessageId,
    role: match.role,
    userId: match.userId,
    content: match.content,
    replyToSourceMessageId: match.replyToSourceMessageId,
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
    chatRef: scopedRef(record.source, "chat", record.chatId),
    summaryDate: record.summaryDate,
    content: record.content,
    messageIds: record.messageIds,
    createdAt: record.createdAt,
    embedded: record.embedded,
  };
}

/** The conversation-store-backed client. */
export function requireSourceContent(): SourceContentClient {
  return {
    async messagesByIds(chatRef, ids) {
      if (ids.length === 0) return [];
      const chat = chatKeyOf(chatRef);
      const rows = await getSourceMessagesByIds(chat.source, chat.chatId, [...ids]);
      return (await withMedia(chat, rows)).filter((message) => message.deletedAt == null);
    },
    async messagesWindow(chatRef, window) {
      const chat = chatKeyOf(chatRef);
      const rows = await getSourceMessagesInWindow(chat.source, chat.chatId, window);
      return (await withMedia(chat, rows)).filter((message) => message.deletedAt == null);
    },
    async allMessages(chatRef) {
      const chat = chatKeyOf(chatRef);
      return withMedia(chat, await listSourceChatMessages(chat.source, chat.chatId));
    },
    async importMessages(chatRef, rows) {
      const chat = chatKeyOf(chatRef);
      return appendSourceMessagesBulk(
        chat.source,
        rows.map((row) => ({
          chatId: chat.chatId,
          sourceMessageId: row.sourceMessageId,
          role: row.role,
          userId: row.userId,
          content: row.content,
          replyToSourceMessageId: row.replyToSourceMessageId,
          sentAt: row.sentAt,
          editedAt: row.editedAt,
          deletedAt: row.deletedAt,
        })),
      );
    },
    async dayCounts(timeZone, before) {
      const rows = await listSourceChatDayCounts(await contentSources(), { timeZone, before });
      return rows.map((row) => ({
        chatRef: chatRefOf(row),
        date: row.date,
        messageCount: row.messageCount,
      }));
    },
    async messageSeries(params) {
      return getSourceMessageSeries(await contentSources(), {
        fromUtc: params.fromUtc,
        toUtc: params.toUtc,
        unit: params.unit,
        timeZone: params.timeZone,
        chat: params.chatRef ? chatKeyOf(params.chatRef) : null,
        user: params.userRef ? userKeyOf(params.userRef) : null,
      });
    },
    async newUserSeries(params) {
      return getSourceNewUserSeries(await contentSources(), params);
    },
    async topUsers(params) {
      const rows = await getSourceTopUsers(await contentSources(), {
        fromUtc: params.fromUtc,
        toUtc: params.toUtc,
        chat: params.chatRef ? chatKeyOf(params.chatRef) : null,
        limit: params.limit,
      });
      return rows.map((row) => ({
        userRef: scopedRef(row.source, "user", row.userId),
        messages: row.messages,
      }));
    },
    async messageAvailability(params) {
      return getSourceMessageAvailability(await contentSources(), {
        fromUtc: params.fromUtc,
        toUtc: params.toUtc,
        unit: params.unit,
        timeZone: params.timeZone,
        chat: params.chatRef ? chatKeyOf(params.chatRef) : null,
      });
    },
    async hourCounts(params) {
      const rows = await listSourceChatHourCounts(await contentSources(), params);
      return rows.map((row) => ({
        chatRef: chatRefOf(row),
        insightHour: row.insightHour,
        messageCount: row.messageCount,
      }));
    },
    async listSummariesForDay(chatRef, date) {
      return (await listSourceChatSummaries(chatKeyOf(chatRef), 200, date)).map(toSummary);
    },
    async replaceSummaries(chatRef, summaryDate, topics) {
      const stored = await replaceSourceSummariesForDay(chatKeyOf(chatRef), {
        summaryDate,
        topics: topics.map((topic) => ({
          content: topic.content,
          messageIds: topic.messageIds,
          embedding: topic.embedding,
        })),
      });
      return stored.map(toSummary);
    },
    async listSummaries(chatRef, limit = 200) {
      return (await listSourceChatSummaries(chatKeyOf(chatRef), limit)).map(toSummary);
    },
    async summaryCounts() {
      const rows = await countSourceSummariesByChat(await contentSources());
      return new Map(rows.map((row) => [chatRefOf(row), row.topicCount]));
    },
    async searchMessages(params) {
      const matches = await searchSourceMessagesHybrid({
        sources: await contentSources(),
        chat: params.chatRef ? chatKeyOf(params.chatRef) : null,
        queryText: params.queryText,
        queryVector: params.queryVector,
        limit: params.limit,
        filters: params.filters,
      });
      return matches.map(toMatch);
    },
    async searchSummaries(params) {
      const matches = await searchSourceSummariesHybrid(chatKeyOf(params.chatRef), {
        queryText: params.queryText,
        queryVector: params.queryVector,
        limit: params.limit,
      });
      return matches.map((match) => ({ ...toSummary(match), score: match.score }));
    },
    async indexDue(limit) {
      const sources = await contentSources();
      const [messages, total] = await Promise.all([
        listSourceMessagesNeedingIndex(sources, limit),
        countSourceMessagesNeedingIndex(sources),
      ]);
      return {
        messages: messages.map((row) => ({
          chatRef: chatRefOf(row),
          sourceMessageId: row.sourceMessageId,
          content: row.content,
          media: row.media,
        })),
        total,
      };
    },
    async putIndexRows(rows) {
      await upsertSourceMessageIndex(
        rows.map((row) => ({
          ...chatKeyOf(row.chatRef),
          sourceMessageId: row.sourceMessageId,
          content: row.content,
          embedding: row.embedding,
        })),
      );
    },
    async clearIndex() {
      return clearSourceMessageIndex(await contentSources());
    },
    async countEmbedded(chatRef) {
      return countEmbeddedSourceMessages(chatKeyOf(chatRef));
    },
  };
}
