import "server-only";

import type { StoreDb } from "@/server/store/db";
import { scopedRef, tryParseScopedRef } from "@assistant-hub/contracts";

import { chatSummaryDays } from "../../../store/schema";
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
export async function listSummaryDayMarkers(db: StoreDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      chatRef: chatSummaryDays.chatRef,
      summaryDate: chatSummaryDays.summaryDate,
      messageCount: chatSummaryDays.messageCount,
    })
    .from(chatSummaryDays);
  // The store keys markers by scoped ref (Phase 10); the scan compares by
  // the tg-local chat id it walks.
  return new Map(
    rows.map((row) => [
      `${tryParseScopedRef(row.chatRef)?.id ?? row.chatRef}|${row.summaryDate}`,
      row.messageCount,
    ]),
  );
}

/**
 * Stamp a day as summarized at its current message count. Written even for a
 * day that distilled to nothing, so a chat-day of pure noise is never
 * re-summarized on every run forever (v1 semantics).
 */
export async function upsertSummaryDayMarker(
  db: StoreDb,
  input: {
    chatId: string;
    summaryDate: SummaryDate;
    messageCount: number;
    topicCount: number;
  },
): Promise<void> {
  const { chatId, ...rest } = input;
  const marker = { ...rest, chatRef: scopedRef("tg", "chat", chatId), summarizedAt: new Date() };
  await db
    .insert(chatSummaryDays)
    .values(marker)
    .onConflictDoUpdate({
      target: [chatSummaryDays.chatRef, chatSummaryDays.summaryDate],
      set: marker,
    });
}
