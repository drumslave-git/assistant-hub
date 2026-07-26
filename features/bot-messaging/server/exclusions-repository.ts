import "server-only";

import { desc, eq } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { addressingExclusions, type AddressingExclusionRow } from "@/db/schema";
import { normalizeExclusionTerm, type AddressingExclusion } from "../exclusions";

/**
 * Data access for addressing exclusions. Pure persistence — the flow that
 * creates one (a 👎 "wasn't talking to you" answer) and its tracing live in the
 * self-improvement service; the reads are consumed by the addressing analyzer.
 */

function mapExclusion(row: AddressingExclusionRow): AddressingExclusion {
  return {
    id: row.id,
    term: row.term,
    normalized: row.normalized,
    botDisplayName: row.botDisplayName,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    userId: row.userId,
    feedbackId: row.feedbackId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A new exclusion to record, with the provenance of the report that made it. */
export interface InsertAddressingExclusion {
  id: string;
  term: string;
  botDisplayName: string;
  chatId?: string | null;
  telegramMessageId?: number | null;
  userId?: string | null;
  feedbackId?: string | null;
}

/**
 * Record an exclusion, or return the existing one when the word is already
 * excluded. Two people reporting the same false trigger is the normal case, not
 * a conflict — the first report's provenance is kept.
 */
export async function insertAddressingExclusion(
  db: DrizzleDb,
  values: InsertAddressingExclusion,
): Promise<{ exclusion: AddressingExclusion; created: boolean }> {
  const normalized = normalizeExclusionTerm(values.term);
  const [inserted] = await db
    .insert(addressingExclusions)
    .values({
      id: values.id,
      term: values.term.trim(),
      normalized,
      botDisplayName: values.botDisplayName,
      chatId: values.chatId ?? null,
      telegramMessageId: values.telegramMessageId ?? null,
      userId: values.userId ?? null,
      feedbackId: values.feedbackId ?? null,
    })
    .onConflictDoNothing({ target: addressingExclusions.normalized })
    .returning();
  if (inserted) return { exclusion: mapExclusion(inserted), created: true };

  const existing = await db.query.addressingExclusions.findFirst({
    where: eq(addressingExclusions.normalized, normalized),
  });
  // The conflicting row is gone only if it was deleted between the two
  // statements; re-inserting would race the same way, so report the term as-is.
  if (!existing) throw new Error(`Exclusion "${values.term}" could not be stored`);
  return { exclusion: mapExclusion(existing), created: false };
}

/** All exclusions, newest first (dashboard). */
export async function listAddressingExclusions(
  db: DrizzleDb = getDb(),
): Promise<AddressingExclusion[]> {
  const rows = await db
    .select()
    .from(addressingExclusions)
    .orderBy(desc(addressingExclusions.createdAt));
  return rows.map(mapExclusion);
}

/**
 * The excluded words alone, as the analyzer consumes them (verbatim terms — the
 * prompt shows the model the word people actually wrote).
 */
export async function listAddressingExclusionTerms(
  db: DrizzleDb = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ term: addressingExclusions.term })
    .from(addressingExclusions)
    .orderBy(desc(addressingExclusions.createdAt));
  return rows.map((row) => row.term);
}

/** Remove one exclusion. Returns the removed row, or null when it was gone. */
export async function deleteAddressingExclusion(
  db: DrizzleDb,
  id: string,
): Promise<AddressingExclusion | null> {
  const [row] = await db
    .delete(addressingExclusions)
    .where(eq(addressingExclusions.id, id))
    .returning();
  return row ? mapExclusion(row) : null;
}
