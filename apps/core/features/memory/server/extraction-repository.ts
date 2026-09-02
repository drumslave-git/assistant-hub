import "server-only";

import type { StoreDb } from "@/server/store/db";

import { memoryExtractionDays } from "../../../store/schema";
import { chatDayKey } from "@/features/history/server/summaries-repository";
import type { SummaryDate } from "@/features/history/summary";
import type { SourceContentClient } from "@/server/source/content";

/**
 * Typed persistence for the passive-extraction markers (`memory_extraction_days`)
 * and the due-scan that drives the job. Pure data access — no LLM, no tracing;
 * `extract.ts` owns those. Chats are keyed by scoped ref.
 *
 * The scan is a deliberate twin of history's `listDaysNeedingSummary`: both ask
 * "which finished chat-days hold messages this job has not processed at their
 * current message count". Kept separate rather than generalized into one
 * parameterized scan because the two jobs must fail, re-run, and backfill
 * independently — a shared scan would couple their progress, and the third
 * consumer that would justify the abstraction does not exist.
 */

/** A (chat, day) pair extraction still owes work on. */
export interface PendingExtractionDay {
  chatRef: string;
  extractionDate: SummaryDate;
  /** Messages the day currently holds — what the marker records once extracted. */
  messageCount: number;
}

/**
 * Stamp a day as extracted, recording the message count it was extracted at.
 *
 * Written even for a day that yielded **no** facts: a day of pure chit-chat is a
 * correct empty result, and without a marker it would be re-read (and re-spent on
 * the LLM) on every run forever.
 */
export async function stampExtractionDay(
  db: StoreDb,
  input: {
    chatRef: string;
    extractionDate: SummaryDate;
    messageCount: number;
    noteCount: number;
  },
): Promise<void> {
  const marker = { ...input, extractedAt: new Date() };
  await db
    .insert(memoryExtractionDays)
    .values(marker)
    .onConflictDoUpdate({
      target: [memoryExtractionDays.chatRef, memoryExtractionDays.extractionDate],
      set: marker,
    });
}

/**
 * (chat, day) pairs that need extracting: every finished day holding messages
 * whose marker is missing, or whose recorded message count no longer matches the
 * day's live count.
 *
 * Retroactive by construction, exactly like the summarizer's scan — the first run
 * after this feature ships walks the *entire* history the mirror has ever stored,
 * oldest day first, so everything the bot sat silently through is finally read.
 * Afterwards each run finds only what is genuinely new or changed.
 *
 * `today` is excluded: it is unfinished, and every reply already carries it
 * verbatim via the 24-hour window, so extracting it now would only have to be
 * redone tonight.
 */
export async function listDaysNeedingExtraction(
  content: SourceContentClient,
  db: StoreDb,
  params: { timeZone: string; today: SummaryDate; limit: number },
): Promise<PendingExtractionDay[]> {
  // The counts come from the conversation store; the markers are this job's
  // own state — compared here (the v1 SQL join, split across stores).
  const [days, markers] = await Promise.all([
    content.dayCounts(params.timeZone, params.today),
    db
      .select({
        chatRef: memoryExtractionDays.chatRef,
        extractionDate: memoryExtractionDays.extractionDate,
        messageCount: memoryExtractionDays.messageCount,
      })
      .from(memoryExtractionDays)
      .then(
        (rows) =>
          new Map(rows.map((row) => [chatDayKey(row.chatRef, row.extractionDate), row.messageCount])),
      ),
  ]);
  return days
    .filter((day) => markers.get(chatDayKey(day.chatRef, day.date)) !== day.messageCount)
    .slice(0, params.limit)
    .map((day) => ({
      chatRef: day.chatRef,
      extractionDate: day.date,
      messageCount: day.messageCount,
    }));
}

/** How many (chat, day) pairs are still awaiting extraction — for the dashboard. */
export async function countDaysNeedingExtraction(
  content: SourceContentClient,
  db: StoreDb,
  params: { timeZone: string; today: SummaryDate },
): Promise<number> {
  const pending = await listDaysNeedingExtraction(content, db, { ...params, limit: 1_000_000 });
  return pending.length;
}
