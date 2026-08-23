import { and, asc, desc, eq, sql } from "drizzle-orm";

import { summaries } from "../../store/schema";
import type { TgDb } from "../db";
import { mapSummaryRow, type SummaryRecord } from "./search";

/**
 * Daily topic summaries — conversation-derived content that lives with the
 * mirror it summarizes (user decision, 2026-08-22). The core's
 * summarization job composes and embeds the topics and writes them back
 * here; the job's own coverage markers (which chat-days are done) are core
 * state and stay on its side, which is why the day scan is split: this app
 * serves the per-(chat, day) message counts, the core compares them with
 * its markers.
 */

/** A topic to store, with its embedding (null when embeddings are unconfigured). */
export interface InsertSummary {
  content: string;
  messageIds: number[];
  embedding: number[] | null;
}

/**
 * Replace a day's topics atomically (v1 `replaceSummariesForDay`, minus the
 * marker — the core stamps its own). Replacing rather than appending is
 * what makes a re-run idempotent.
 */
export async function replaceSummariesForDay(
  db: TgDb,
  input: { chatId: string; summaryDate: string; topics: readonly InsertSummary[] },
): Promise<SummaryRecord[]> {
  return db.transaction(async (tx) => {
    await tx
      .delete(summaries)
      .where(and(eq(summaries.chatId, input.chatId), eq(summaries.summaryDate, input.summaryDate)));
    const rows =
      input.topics.length > 0
        ? await tx
            .insert(summaries)
            .values(
              input.topics.map((topic) => ({
                chatId: input.chatId,
                summaryDate: input.summaryDate,
                content: topic.content,
                messageIds: topic.messageIds,
                embedding: topic.embedding,
              })),
            )
            .returning()
        : [];
    return rows.map(mapSummaryRow);
  });
}

/** A chat's stored topics, newest day first (the dashboard view). */
export async function listChatSummaries(
  db: TgDb,
  chatId: string,
  limit = 200,
  /** Restrict to one day's topics (the insight job's extra-context read). */
  date?: string,
): Promise<SummaryRecord[]> {
  const where = date
    ? and(eq(summaries.chatId, chatId), eq(summaries.summaryDate, date))
    : eq(summaries.chatId, chatId);
  const rows = await db
    .select()
    .from(summaries)
    .where(where)
    .orderBy(desc(summaries.summaryDate), asc(summaries.id))
    .limit(limit);
  return rows.map(mapSummaryRow);
}

/** Per-chat topic counts, for the History overview. */
export async function countSummariesByChat(db: TgDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ chatId: summaries.chatId, topicCount: sql<number>`count(*)::int` })
    .from(summaries)
    .groupBy(summaries.chatId);
  return new Map(rows.map((row) => [row.chatId, row.topicCount]));
}

/** One (chat, day)'s visible message count, in the given zone's calendar. */
export interface ChatDayCount {
  chatId: string;
  /** `YYYY-MM-DD` in the requested timezone. */
  date: string;
  messageCount: number;
}

/**
 * Per-(chat, day) visible message counts for every day strictly before
 * `before` — the summarizer's half of the day scan (its markers live with
 * the core). Days bucket by the operator's wall clock (`AT TIME ZONE`),
 * matching how summaries are dated and how a person asks for them.
 */
export async function listChatDayCounts(
  db: TgDb,
  params: { timeZone: string; before: string },
): Promise<ChatDayCount[]> {
  const rows = await db.execute<{
    chat_id: string;
    day: string;
    message_count: number;
  }>(sql`
    with days as (
      select
        chat_id,
        to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') as day,
        count(*)::int as message_count
      from messages
      where deleted_at is null
      group by 1, 2
    )
    select chat_id, day, message_count
    from days
    where day < ${params.before}
    order by day asc, chat_id asc
  `);
  return rows.rows.map((row) => ({
    chatId: row.chat_id,
    date: row.day,
    messageCount: Number(row.message_count),
  }));
}
