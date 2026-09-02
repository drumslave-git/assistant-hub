import "server-only";

import type { StoreDb } from "@/server/store/db";

import { chatSummaryDays } from "../../../store/schema";
import type { SummaryDate } from "../summary";

export type { SourceSummary as ChatSummaryRecord } from "@/server/source/content";

/**
 * The summarization job's own coverage markers (`chat_summary_days`) — which
 * chat-days are done, at what message count. Job state, so it stays on the
 * core's side (user decision, 2026-08-22); the summaries themselves are
 * conversation-derived content and live in the conversation store. The due
 * scan is therefore split: the content plane serves per-(chat, day) message
 * counts, and {@link listSummaryDayMarkers} is the half they are compared
 * against. Chats are keyed by scoped ref, like the rest of the core.
 */

/** Marker state for one (chat, day): the counts recorded when it was summarized. */
export interface SummaryDayMarker {
  chatRef: string;
  summaryDate: SummaryDate;
  messageCount: number;
}

/** The scan's comparison key for one (chat, day). */
export const chatDayKey = (chatRef: string, date: string): string => `${chatRef}|${date}`;

/** Every marker, keyed `chatRef|date` for the scan's comparison. */
export async function listSummaryDayMarkers(db: StoreDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      chatRef: chatSummaryDays.chatRef,
      summaryDate: chatSummaryDays.summaryDate,
      messageCount: chatSummaryDays.messageCount,
    })
    .from(chatSummaryDays);
  return new Map(rows.map((row) => [chatDayKey(row.chatRef, row.summaryDate), row.messageCount]));
}

/**
 * Stamp a day as summarized at its current message count. Written even for a
 * day that distilled to nothing, so a chat-day of pure noise is never
 * re-summarized on every run forever (v1 semantics).
 */
export async function upsertSummaryDayMarker(
  db: StoreDb,
  input: {
    chatRef: string;
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
      target: [chatSummaryDays.chatRef, chatSummaryDays.summaryDate],
      set: marker,
    });
}
