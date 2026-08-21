import "server-only";

import { sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { memoryExtractionDays } from "@/db/schema";
import type { SummaryDate } from "@/features/history/summary";

/**
 * Typed persistence for the passive-extraction markers (`memory_extraction_days`)
 * and the due-scan that drives the job. Pure data access — no LLM, no tracing;
 * `extract.ts` owns those.
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
  chatId: string;
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
  db: DrizzleDb,
  input: {
    chatId: string;
    extractionDate: SummaryDate;
    messageCount: number;
    noteCount: number;
  },
): Promise<void> {
  const marker = {
    chatId: input.chatId,
    extractionDate: input.extractionDate,
    messageCount: input.messageCount,
    noteCount: input.noteCount,
    extractedAt: new Date(),
  };
  await db
    .insert(memoryExtractionDays)
    .values(marker)
    .onConflictDoUpdate({
      target: [memoryExtractionDays.chatId, memoryExtractionDays.extractionDate],
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
  db: DrizzleDb,
  params: { timeZone: string; today: SummaryDate; limit: number },
): Promise<PendingExtractionDay[]> {
  const rows = await db.execute<{
    chat_id: string;
    extraction_date: string;
    message_count: number;
  }>(sql`
    with days as (
      select
        chat_id,
        to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') as extraction_date,
        count(*)::int as message_count
      from chat_messages
      where deleted_at is null
      group by 1, 2
    )
    select days.chat_id, days.extraction_date, days.message_count
    from days
    left join memory_extraction_days m
      on m.chat_id = days.chat_id and m.extraction_date = days.extraction_date
    where days.extraction_date < ${params.today}
      and (m.id is null or m.message_count <> days.message_count)
    order by days.extraction_date asc, days.chat_id asc
    limit ${params.limit}
  `);

  return rows.rows.map((row) => ({
    chatId: row.chat_id,
    extractionDate: row.extraction_date,
    messageCount: Number(row.message_count),
  }));
}

/** How many (chat, day) pairs are still awaiting extraction — for the dashboard. */
export async function countDaysNeedingExtraction(
  db: DrizzleDb,
  params: { timeZone: string; today: SummaryDate },
): Promise<number> {
  const pending = await listDaysNeedingExtraction(db, { ...params, limit: 10_000 });
  return pending.length;
}
