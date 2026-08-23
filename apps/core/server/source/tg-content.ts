import "server-only";

import {
  contentBucketsResponseSchema,
  contentDayCountsResponseSchema,
  contentEmbeddedCountResponseSchema,
  contentHourCountsResponseSchema,
  contentMessageSeriesResponseSchema,
  contentNewUserSeriesResponseSchema,
  contentTopUsersResponseSchema,
  type ContentBucketUnit,
  contentImportResponseSchema,
  contentIndexClearResponseSchema,
  contentIndexDueResponseSchema,
  contentMessagesResponseSchema,
  contentSearchMessagesResponseSchema,
  contentSearchSummariesResponseSchema,
  contentSummariesResponseSchema,
  contentSummaryCountsResponseSchema,
  type ContentMessage,
  type ContentMessageMatch,
  type ContentSummary,
} from "@assistant-hub/contracts";

import { getEnv } from "@/server/env";

/**
 * The owning source's conversation content over its internal API — what the
 * core's history/search/summarization features read and write since the
 * swap. Shapes mirror the v1 repositories so the features' composition code
 * (transcripts, views, tools) carries over unchanged; the SQL itself runs
 * source-side, next to the data and its indexes.
 */

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

function toChatMessage(message: ContentMessage): SourceChatMessage {
  return {
    id: message.id,
    chatId: message.chatId,
    telegramMessageId: Number(message.sourceMessageId),
    role: message.role,
    userId: message.userId,
    content: message.content,
    replyToMessageId:
      message.replyToSourceMessageId != null ? Number(message.replyToSourceMessageId) : null,
    sentAt: message.sentAt,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    botReaction: message.botReaction,
    createdAt: message.createdAt,
    media: message.media,
  };
}

function toMessageMatch(match: ContentMessageMatch): SourceMessageMatch {
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
    deletedAt: match.deletedAt,
    botReaction: match.botReaction,
    createdAt: match.createdAt,
    indexedContent: match.indexedContent,
    mediaKind: match.mediaKind,
    score: match.score,
  };
}

function toSummary(summary: ContentSummary): SourceSummary {
  return {
    id: summary.id,
    chatId: summary.chatId,
    summaryDate: summary.summaryDate,
    content: summary.content,
    messageIds: summary.messageIds,
    createdAt: summary.createdAt,
    embedded: summary.embedded,
  };
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

const REQUEST_TIMEOUT_MS = 60_000;

/** The tg-API-backed client, or null when the source API is not configured. */
export function resolveSourceContent(): SourceContentClient | null {
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  const baseUrl = env.TG_API_URL.replace(/\/$/, "");
  const token = env.INTERNAL_API_TOKEN;

  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `tg internal API ${path} answered ${res.status}`);
    }
    return res.json();
  };

  const chatPath = (chatId: string, rest: string) =>
    `/internal/chats/${encodeURIComponent(chatId)}${rest}`;

  return {
    async messagesByIds(chatId, ids) {
      if (ids.length === 0) return [];
      const body = contentMessagesResponseSchema.parse(
        await request(chatPath(chatId, `/content-messages?ids=${ids.join(",")}`)),
      );
      return body.messages.map(toChatMessage).filter((message) => message.deletedAt == null);
    },
    async messagesWindow(chatId, window) {
      const query = new URLSearchParams({
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        ...(window.endExclusive ? { endExclusive: "true" } : {}),
      });
      const body = contentMessagesResponseSchema.parse(
        await request(chatPath(chatId, `/content-messages?${query.toString()}`)),
      );
      return body.messages.map(toChatMessage).filter((message) => message.deletedAt == null);
    },
    async allMessages(chatId) {
      const body = contentMessagesResponseSchema.parse(
        await request(chatPath(chatId, "/content-messages")),
      );
      return body.messages.map(toChatMessage);
    },
    async importMessages(chatId, rows) {
      const body = contentImportResponseSchema.parse(
        await request(chatPath(chatId, "/messages/import"), {
          method: "POST",
          body: JSON.stringify({
            messages: rows.map((row) => ({
              sourceMessageId: String(row.telegramMessageId),
              role: row.role,
              userId: row.userId,
              content: row.content,
              replyToSourceMessageId:
                row.replyToMessageId != null ? String(row.replyToMessageId) : null,
              sentAt: row.sentAt.toISOString(),
              editedAt: row.editedAt ? row.editedAt.toISOString() : null,
              deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
            })),
          }),
        }),
      );
      return body.inserted;
    },
    async dayCounts(timeZone, before) {
      const query = new URLSearchParams({ tz: timeZone, before });
      const body = contentDayCountsResponseSchema.parse(
        await request(`/internal/messages/day-counts?${query.toString()}`),
      );
      return body.days;
    },
    async messageSeries(params) {
      const query = new URLSearchParams({
        from: params.fromUtc.toISOString(),
        to: params.toUtc.toISOString(),
        unit: params.unit,
        tz: params.timeZone,
        ...(params.chatId ? { chatId: params.chatId } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
      });
      const body = contentMessageSeriesResponseSchema.parse(
        await request(`/internal/analytics/message-series?${query.toString()}`),
      );
      return body.rows;
    },
    async newUserSeries(params) {
      const query = new URLSearchParams({
        from: params.fromUtc.toISOString(),
        to: params.toUtc.toISOString(),
        unit: params.unit,
        tz: params.timeZone,
      });
      const body = contentNewUserSeriesResponseSchema.parse(
        await request(`/internal/analytics/new-user-series?${query.toString()}`),
      );
      return body.rows;
    },
    async topUsers(params) {
      const query = new URLSearchParams({
        from: params.fromUtc.toISOString(),
        to: params.toUtc.toISOString(),
        limit: String(params.limit),
        ...(params.chatId ? { chatId: params.chatId } : {}),
      });
      const body = contentTopUsersResponseSchema.parse(
        await request(`/internal/analytics/top-users?${query.toString()}`),
      );
      return body.rows;
    },
    async messageAvailability(params) {
      const query = new URLSearchParams({
        from: params.fromUtc.toISOString(),
        to: params.toUtc.toISOString(),
        unit: params.unit,
        tz: params.timeZone,
        ...(params.chatId ? { chatId: params.chatId } : {}),
      });
      const body = contentBucketsResponseSchema.parse(
        await request(`/internal/analytics/availability?${query.toString()}`),
      );
      return body.buckets;
    },
    async hourCounts(params) {
      const query = new URLSearchParams({
        tz: params.timeZone,
        ...(params.fromUtc ? { from: params.fromUtc.toISOString() } : {}),
      });
      const body = contentHourCountsResponseSchema.parse(
        await request(`/internal/analytics/hour-counts?${query.toString()}`),
      );
      return body.hours;
    },
    async listSummariesForDay(chatId, date) {
      const body = contentSummariesResponseSchema.parse(
        await request(chatPath(chatId, `/summaries?date=${encodeURIComponent(date)}`)),
      );
      return body.summaries.map(toSummary);
    },
    async replaceSummaries(chatId, summaryDate, topics) {
      const body = contentSummariesResponseSchema.parse(
        await request(chatPath(chatId, `/summaries/${encodeURIComponent(summaryDate)}`), {
          method: "PUT",
          body: JSON.stringify({ topics }),
        }),
      );
      return body.summaries.map(toSummary);
    },
    async listSummaries(chatId, limit = 200) {
      const body = contentSummariesResponseSchema.parse(
        await request(chatPath(chatId, `/summaries?limit=${limit}`)),
      );
      return body.summaries.map(toSummary);
    },
    async summaryCounts() {
      const body = contentSummaryCountsResponseSchema.parse(
        await request("/internal/summaries/counts"),
      );
      return new Map(body.counts.map((row) => [row.chatId, row.topicCount]));
    },
    async searchMessages(params) {
      const body = contentSearchMessagesResponseSchema.parse(
        await request("/internal/search/messages", {
          method: "POST",
          body: JSON.stringify(params),
        }),
      );
      return body.matches.map(toMessageMatch);
    },
    async searchSummaries(params) {
      const body = contentSearchSummariesResponseSchema.parse(
        await request("/internal/search/summaries", {
          method: "POST",
          body: JSON.stringify(params),
        }),
      );
      return body.matches.map((match) => ({ ...toSummary(match), score: match.score }));
    },
    async indexDue(limit) {
      const body = contentIndexDueResponseSchema.parse(
        await request(`/internal/index/due?limit=${limit}`),
      );
      return {
        messages: body.messages.map((row) => ({
          chatId: row.chatId,
          telegramMessageId: Number(row.sourceMessageId),
          content: row.content,
          media: row.media,
        })),
        total: body.total,
      };
    },
    async putIndexRows(rows) {
      await request("/internal/index/rows", {
        method: "PUT",
        body: JSON.stringify({
          rows: rows.map((row) => ({
            chatId: row.chatId,
            sourceMessageId: String(row.telegramMessageId),
            content: row.content,
            embedding: row.embedding,
          })),
        }),
      });
    },
    async clearIndex() {
      const body = contentIndexClearResponseSchema.parse(
        await request("/internal/index/clear", { method: "POST" }),
      );
      return body.removed;
    },
    async countEmbedded(chatId) {
      const body = contentEmbeddedCountResponseSchema.parse(
        await request(`/internal/index/embedded-count?chatId=${encodeURIComponent(chatId)}`),
      );
      return body.count;
    },
  };
}

/** The client, or an audible failure naming the missing configuration. */
export function requireSourceContent(): SourceContentClient {
  const client = resolveSourceContent();
  if (!client) {
    throw new Error("telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN)");
  }
  return client;
}
