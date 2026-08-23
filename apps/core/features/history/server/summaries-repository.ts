import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { chatSummaryDays } from "@/db/schema";
import type { SummaryDate } from "../summary";

export type { SourceSummary as ChatSummaryRecord } from "@/server/source/tg-content";

/**
 * The summarization job's own coverage markers (`chat_summary_days`) — which
 * chat-days are done, at what message count. Job state, so it stays on the
 * core's side (user decision, 2026-08-22); the summaries themselves are
 * conversation-derived content and live with the owning source's mirror,
 * written through its internal API. The due scan is therefore split: the
 * source serves per-(chat, day) message counts, and {@link listSummaryDayMarkers}
 * is the half they are compared against.
 */

/** Marker state for one (chat, day): the counts recorded when it was summarized. */
export interface SummaryDayMarker {
  chatId: string;
  summaryDate: SummaryDate;
  messageCount: number;
}

/** Every marker, keyed `chatId|date` for the scan's comparison. */
export async function listSummaryDayMarkers(db: DrizzleDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      chatId: chatSummaryDays.chatId,
      summaryDate: chatSummaryDays.summaryDate,
      messageCount: chatSummaryDays.messageCount,
    })
    .from(chatSummaryDays);
  return new Map(rows.map((row) => [`${row.chatId}|${row.summaryDate}`, row.messageCount]));
}

/**
 * Stamp a day as summarized at its current message count. Written even for a
 * day that distilled to nothing, so a chat-day of pure noise is never
 * re-summarized on every run forever (v1 semantics).
 */
export async function upsertSummaryDayMarker(
  db: DrizzleDb,
  input: {
    chatId: string;
    summaryDate: SummaryDate;
    messageCount: number;
    topicCount: number;
  },
): Promise<void> {
  const marker = { ...input, summarizedAt: new Date() };
  await db
    .insert(chatSummaryDays)
    .values(marker)
    .onConflictDoUpdate({
      target: [chatSummaryDays.chatId, chatSummaryDays.summaryDate],
      set: marker,
    });
}
