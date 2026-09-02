import type { ContentBucketUnit } from "@assistant-hub-swarm/contracts";

import { bucketKeyOfInstant } from "@/features/analytics/period";
import type {
  SourceChatMessage,
  SourceContentClient,
  SourceSummary,
} from "@/server/source/tg-content";

/**
 * In-memory {@link SourceContentClient} for job-logic tests: faithful about
 * the CONTRACT (windows, day buckets, idempotent writes, due accounting) and
 * deliberately naive about RANKING — hybrid-search semantics are the
 * source's SQL and are tested in the tg app against a real database. Search
 * here is substring match, which is all the core-side logic depends on.
 */
export interface FakeSourceContent extends SourceContentClient {
  rows: SourceChatMessage[];
  summariesStore: SourceSummary[];
  /** First sightings, for `newUserSeries` — tests seed it directly. */
  usersStore: { userId: string; firstSeenAt: Date }[];
  /** `chatId|telegramMessageId` → indexed content; null embedding tracked. */
  index: Map<string, { content: string; embedding: number[] | null }>;
  addMessage(input: {
    chatId: string;
    telegramMessageId: number;
    role?: "user" | "assistant";
    userId?: string | null;
    content?: string;
    replyToMessageId?: number | null;
    sentAt?: Date;
    editedAt?: Date | null;
    deletedAt?: Date | null;
    botReaction?: string | null;
    media?: SourceChatMessage["media"];
  }): SourceChatMessage;
  /** Mark one message's index row stale (a description arrived). */
  markDirty(chatId: string, telegramMessageId: number): void;
}

/** `YYYY-MM-DD` of an instant in a zone (the source buckets days this way). */
function dayInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

export function fakeSourceContent(): FakeSourceContent {
  const rows: SourceChatMessage[] = [];
  const summariesStore: SourceSummary[] = [];
  const index = new Map<string, { content: string; embedding: number[] | null }>();
  const dirty = new Set<string>();
  let nextId = 0;
  let nextSummaryId = 0;

  const keyOf = (chatId: string, telegramMessageId: number) => `${chatId}|${telegramMessageId}`;
  const visible = (row: SourceChatMessage) => row.deletedAt == null;

  const usersStore: { userId: string; firstSeenAt: Date }[] = [];

  /** The core period module's bucket key — the source formats to match it. */
  const bucketOf = (instant: Date, unit: ContentBucketUnit, timeZone: string) =>
    unit === "all" ? "all" : bucketKeyOfInstant(instant, unit, timeZone);

  const client: FakeSourceContent = {
    rows,
    summariesStore,
    usersStore,
    index,
    addMessage(input) {
      const row: SourceChatMessage = {
        id: ++nextId,
        chatId: input.chatId,
        telegramMessageId: input.telegramMessageId,
        role: input.role ?? "user",
        userId: input.userId !== undefined ? input.userId : (input.role ?? "user") === "user" ? "100" : null,
        content: input.content ?? "",
        replyToMessageId: input.replyToMessageId ?? null,
        sentAt: (input.sentAt ?? new Date()).toISOString(),
        editedAt: input.editedAt ? input.editedAt.toISOString() : null,
        deletedAt: input.deletedAt ? input.deletedAt.toISOString() : null,
        botReaction: input.botReaction ?? null,
        createdAt: new Date().toISOString(),
        media: input.media ?? null,
      };
      rows.push(row);
      return row;
    },
    markDirty(chatId, telegramMessageId) {
      dirty.add(keyOf(chatId, telegramMessageId));
    },
    async messagesByIds(chatId, ids) {
      return rows
        .filter(
          (row) =>
            row.chatId === chatId && ids.includes(row.telegramMessageId) && visible(row),
        )
        .sort((a, b) => a.id - b.id);
    },
    async messagesWindow(chatId, window) {
      const from = window.from.getTime();
      const to = window.to.getTime();
      return rows
        .filter((row) => {
          if (row.chatId !== chatId || !visible(row)) return false;
          const at = new Date(row.sentAt).getTime();
          return at >= from && (window.endExclusive ? at < to : at <= to);
        })
        .sort((a, b) => a.id - b.id);
    },
    async allMessages(chatId) {
      return rows.filter((row) => row.chatId === chatId).sort((a, b) => a.id - b.id);
    },
    async importMessages(chatId, imported) {
      let inserted = 0;
      for (const row of imported) {
        const exists = rows.some(
          (r) => r.chatId === chatId && r.telegramMessageId === row.telegramMessageId,
        );
        if (exists) continue;
        client.addMessage({ chatId, ...row });
        inserted += 1;
      }
      return inserted;
    },
    async dayCounts(timeZone, before) {
      const counts = new Map<string, { chatId: string; date: string; messageCount: number }>();
      for (const row of rows) {
        if (!visible(row)) continue;
        const date = dayInZone(new Date(row.sentAt), timeZone);
        if (date >= before) continue;
        const key = `${row.chatId}|${date}`;
        const entry = counts.get(key) ?? { chatId: row.chatId, date, messageCount: 0 };
        entry.messageCount += 1;
        counts.set(key, entry);
      }
      return [...counts.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.chatId.localeCompare(b.chatId),
      );
    },
    async messageSeries(params) {
      const buckets = new Map<
        string,
        { human: number; bot: number; activeUsers: Set<string | null> }
      >();
      for (const row of rows) {
        if (!visible(row)) continue;
        const at = new Date(row.sentAt);
        if (at < params.fromUtc || at >= params.toUtc) continue;
        if (params.chatId && row.chatId !== params.chatId) continue;
        if (params.userId && row.userId !== params.userId) continue;
        const bucket = bucketOf(at, params.unit, params.timeZone);
        const entry = buckets.get(bucket) ?? { human: 0, bot: 0, activeUsers: new Set() };
        if (row.role === "user") {
          entry.human += 1;
          entry.activeUsers.add(row.userId);
        } else {
          entry.bot += 1;
        }
        buckets.set(bucket, entry);
      }
      return [...buckets.entries()].map(([bucket, entry]) => ({
        bucket,
        human: entry.human,
        bot: entry.bot,
        activeUsers: entry.activeUsers.size,
      }));
    },
    async newUserSeries(params) {
      const buckets = new Map<string, number>();
      for (const user of usersStore) {
        if (user.firstSeenAt < params.fromUtc || user.firstSeenAt >= params.toUtc) continue;
        const bucket = bucketOf(user.firstSeenAt, params.unit, params.timeZone);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      }
      return [...buckets.entries()].map(([bucket, newUsers]) => ({ bucket, newUsers }));
    },
    async topUsers(params) {
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!visible(row) || row.role !== "user" || row.userId == null) continue;
        const at = new Date(row.sentAt);
        if (at < params.fromUtc || at >= params.toUtc) continue;
        if (params.chatId && row.chatId !== params.chatId) continue;
        counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([userId, messages]) => ({ userId, messages }))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, params.limit);
    },
    async messageAvailability(params) {
      const buckets = new Set<string>();
      for (const row of rows) {
        if (!visible(row)) continue;
        const at = new Date(row.sentAt);
        if (at < params.fromUtc || at >= params.toUtc) continue;
        if (params.chatId && row.chatId !== params.chatId) continue;
        buckets.add(bucketOf(at, params.unit, params.timeZone));
      }
      return [...buckets].sort();
    },
    async hourCounts(params) {
      const counts = new Map<string, { chatId: string; insightHour: string; messageCount: number }>();
      for (const row of rows) {
        if (!visible(row)) continue;
        const at = new Date(row.sentAt);
        if (params.fromUtc && at < params.fromUtc) continue;
        const insightHour = bucketKeyOfInstant(at, "hour", params.timeZone);
        const key = `${row.chatId}|${insightHour}`;
        const entry = counts.get(key) ?? { chatId: row.chatId, insightHour, messageCount: 0 };
        entry.messageCount += 1;
        counts.set(key, entry);
      }
      return [...counts.values()].sort(
        (a, b) => a.insightHour.localeCompare(b.insightHour) || a.chatId.localeCompare(b.chatId),
      );
    },
    async listSummariesForDay(chatId, date) {
      return summariesStore
        .filter((summary) => summary.chatId === chatId && summary.summaryDate === date)
        .sort((a, b) => a.id - b.id);
    },
    async replaceSummaries(chatId, summaryDate, topics) {
      for (let i = summariesStore.length - 1; i >= 0; i -= 1) {
        if (summariesStore[i].chatId === chatId && summariesStore[i].summaryDate === summaryDate) {
          summariesStore.splice(i, 1);
        }
      }
      const stored = topics.map((topic) => ({
        id: ++nextSummaryId,
        chatId,
        summaryDate,
        content: topic.content,
        messageIds: topic.messageIds,
        createdAt: new Date().toISOString(),
        embedded: topic.embedding != null,
      }));
      summariesStore.push(...stored);
      return stored;
    },
    async listSummaries(chatId, limit = 200) {
      return summariesStore
        .filter((summary) => summary.chatId === chatId)
        .sort((a, b) => b.summaryDate.localeCompare(a.summaryDate) || a.id - b.id)
        .slice(0, limit);
    },
    async summaryCounts() {
      const counts = new Map<string, number>();
      for (const summary of summariesStore) {
        counts.set(summary.chatId, (counts.get(summary.chatId) ?? 0) + 1);
      }
      return counts;
    },
    async searchMessages(params) {
      const query = params.queryText.trim().toLowerCase();
      const authorIds = params.filters?.authorUserIds ?? [];
      const kinds = params.filters?.mediaKinds ?? [];
      const scoped = rows.filter((row) => {
        if (!visible(row)) return false;
        if (params.chatId != null && row.chatId !== params.chatId) return false;
        if (authorIds.length > 0 && (row.userId == null || !authorIds.includes(row.userId)))
          return false;
        if (kinds.length > 0 && (row.media == null || !kinds.includes(row.media.kind)))
          return false;
        return true;
      });
      const pool = query
        ? scoped.filter((row) => {
            const indexed = index.get(keyOf(row.chatId, row.telegramMessageId))?.content ?? "";
            return (
              row.content.toLowerCase().includes(query) || indexed.toLowerCase().includes(query)
            );
          })
        : authorIds.length > 0 || kinds.length > 0
          ? scoped
          : [];
      return pool
        .sort((a, b) => a.id - b.id)
        .slice(0, params.limit)
        .map((row) => ({
          id: row.id,
          chatId: row.chatId,
          telegramMessageId: row.telegramMessageId,
          role: row.role,
          userId: row.userId,
          content: row.content,
          replyToMessageId: row.replyToMessageId,
          sentAt: row.sentAt,
          editedAt: row.editedAt,
          deletedAt: null,
          botReaction: row.botReaction,
          createdAt: row.createdAt,
          indexedContent: index.get(keyOf(row.chatId, row.telegramMessageId))?.content ?? null,
          mediaKind: row.media?.kind ?? null,
          score: query ? 1 : 0,
        }));
    },
    async searchSummaries(params) {
      const query = params.queryText.trim().toLowerCase();
      return summariesStore
        .filter(
          (summary) =>
            summary.chatId === params.chatId &&
            (query ? summary.content.toLowerCase().includes(query) : false),
        )
        .slice(0, params.limit)
        .map((summary) => ({ ...summary, score: 1 }));
    },
    async indexDue(limit) {
      const due = rows
        .filter(
          (row) =>
            visible(row) &&
            (!index.has(keyOf(row.chatId, row.telegramMessageId)) ||
              dirty.has(keyOf(row.chatId, row.telegramMessageId))),
        )
        .sort((a, b) => a.id - b.id);
      return {
        messages: due.slice(0, limit).map((row) => ({
          chatId: row.chatId,
          telegramMessageId: row.telegramMessageId,
          content: row.content,
          media: row.media,
        })),
        total: due.length,
      };
    },
    async putIndexRows(indexRows) {
      for (const row of indexRows) {
        index.set(keyOf(row.chatId, row.telegramMessageId), {
          content: row.content,
          embedding: row.embedding,
        });
        dirty.delete(keyOf(row.chatId, row.telegramMessageId));
      }
    },
    async clearIndex() {
      const removed = index.size;
      index.clear();
      return removed;
    },
    async countEmbedded(chatId) {
      let count = 0;
      for (const [key, row] of index) {
        if (key.startsWith(`${chatId}|`) && row.embedding != null) count += 1;
      }
      return count;
    },
  };
  return client;
}
