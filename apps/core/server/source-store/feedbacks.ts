import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { SourceId } from "@assistant-hub/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import { sourceFeedbacks, type SourceFeedbackRow } from "../../store/schema";

/**
 * Feedback rows in the conversation store — the former tg feedback store,
 * source-parameterized. Collection happens through the platform's reactions
 * and menus; the learning jobs (preference/correction folds) read the
 * completed rows and stamp what they incorporated.
 */

export type SourceFeedbackReaction = "up" | "down";
export type SourceFeedbackTopic = "quality" | "addressing";

export interface SourceFeedbackRecord {
  id: string;
  source: SourceId;
  chatId: string;
  sourceMessageId: string;
  userId: string;
  reaction: SourceFeedbackReaction;
  feedback: string | null;
  status: "pending" | "awaiting_text" | "completed";
  topic: SourceFeedbackTopic;
  menuMessageId: string | null;
  /** Clean model name of the reacted reply — stamped from the reply trace. */
  model: string | null;
  reflection: string | null;
  reflectionModel: string | null;
  prefsVersion: number | null;
  correctionsVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapFeedback(row: SourceFeedbackRow): SourceFeedbackRecord {
  return {
    id: row.id,
    source: row.source as SourceId,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
    userId: row.userId,
    reaction: row.reaction === "up" ? "up" : "down",
    feedback: row.feedback,
    status: (["pending", "awaiting_text", "completed"] as const).includes(
      row.status as SourceFeedbackRecord["status"],
    )
      ? (row.status as SourceFeedbackRecord["status"])
      : "pending",
    topic: row.topic === "addressing" ? "addressing" : "quality",
    menuMessageId: row.menuMessageId,
    model: row.model,
    reflection: row.reflection,
    reflectionModel: row.reflectionModel,
    prefsVersion: row.prefsVersion,
    correctionsVersion: row.correctionsVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Record a reaction: insert a `pending` feedback row, or — when this user
 * already reacted to this message — reopen the existing row (new reaction,
 * status back to `pending`, previous answer, reflection and incorporation
 * stamps cleared) so a repeat reaction asks again and the fresh answer is
 * reflected on and picked up by the next incorporation run.
 */
export async function upsertSourceFeedback(
  values: {
    id: string;
    source: SourceId;
    chatId: string;
    sourceMessageId: string;
    userId: string;
    reaction: SourceFeedbackReaction;
  },
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord> {
  const [row] = await db
    .insert(sourceFeedbacks)
    .values(values)
    .onConflictDoUpdate({
      target: [
        sourceFeedbacks.source,
        sourceFeedbacks.chatId,
        sourceFeedbacks.sourceMessageId,
        sourceFeedbacks.userId,
      ],
      set: {
        reaction: values.reaction,
        model: null,
        status: "pending",
        topic: "quality",
        feedback: null,
        menuMessageId: null,
        reflection: null,
        reflectionModel: null,
        prefsVersion: null,
        correctionsVersion: null,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return mapFeedback(row);
}

/** One feedback row by id, or null. */
export async function getSourceFeedback(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord | null> {
  const rows = await db.select().from(sourceFeedbacks).where(eq(sourceFeedbacks.id, id)).limit(1);
  return rows[0] ? mapFeedback(rows[0]) : null;
}

/** Remember the menu message sent for a feedback row. */
export async function setSourceFeedbackMenuMessage(
  id: string,
  menuMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceFeedbacks)
    .set({ menuMessageId, updatedAt: sql`now()` })
    .where(eq(sourceFeedbacks.id, id));
}

/**
 * Store the user's answer and complete the row. `topic` records what the
 * answer is about — it decides whether the daily folds read this row at all,
 * so it is written with the answer rather than derived later.
 */
export async function completeSourceFeedback(
  id: string,
  feedback: string,
  topic: SourceFeedbackTopic = "quality",
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord | null> {
  const [row] = await db
    .update(sourceFeedbacks)
    .set({ feedback, topic, status: "completed", updatedAt: sql`now()` })
    .where(eq(sourceFeedbacks.id, id))
    .returning();
  return row ? mapFeedback(row) : null;
}

/** Flip a row to `awaiting_text` ("Other" tapped — a reply will carry the answer). */
export async function markSourceFeedbackAwaitingText(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceFeedbacks)
    .set({ status: "awaiting_text", updatedAt: sql`now()` })
    .where(eq(sourceFeedbacks.id, id));
}

/** All feedback rows, newest first (the dashboard listing). */
export async function listSourceFeedbacks(
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord[]> {
  const rows = await db.select().from(sourceFeedbacks).orderBy(desc(sourceFeedbacks.createdAt));
  return rows.map(mapFeedback);
}

/**
 * Completed **quality** feedbacks the given fold has not incorporated yet,
 * oldest first. `addressing` rows are deliberately invisible to both folds —
 * nothing ever stamps them, and nothing is meant to.
 */
export async function listUnincorporatedSourceFeedbacks(
  kind: "prefs" | "corrections",
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord[]> {
  const versionColumn =
    kind === "prefs" ? sourceFeedbacks.prefsVersion : sourceFeedbacks.correctionsVersion;
  const rows = await db
    .select()
    .from(sourceFeedbacks)
    .where(
      and(
        eq(sourceFeedbacks.status, "completed"),
        eq(sourceFeedbacks.topic, "quality"),
        isNull(versionColumn),
      ),
    )
    .orderBy(asc(sourceFeedbacks.createdAt));
  return rows.map(mapFeedback);
}

/**
 * Apply a write-back (model / reflection / fold-version stamps). Null when
 * the row is unknown.
 */
export async function patchSourceFeedback(
  id: string,
  patch: {
    model?: string;
    reflection?: string;
    reflectionModel?: string;
    prefsVersion?: number;
    correctionsVersion?: number;
  },
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord | null> {
  const rows = await db
    .update(sourceFeedbacks)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(sourceFeedbacks.id, id))
    .returning();
  return rows[0] ? mapFeedback(rows[0]) : null;
}

/**
 * The `awaiting_text` feedback whose menu message the given user replied to,
 * or null. Backs the free-text capture: a reply to the menu from the reactor
 * is the feedback answer, not a normal bot turn.
 */
export async function findAwaitingSourceFeedbackByMenu(
  source: SourceId,
  chatId: string,
  menuMessageId: string,
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceFeedbackRecord | null> {
  const rows = await db
    .select()
    .from(sourceFeedbacks)
    .where(
      and(
        eq(sourceFeedbacks.source, source),
        eq(sourceFeedbacks.chatId, chatId),
        eq(sourceFeedbacks.menuMessageId, menuMessageId),
        eq(sourceFeedbacks.userId, userId),
        eq(sourceFeedbacks.status, "awaiting_text"),
      ),
    )
    .limit(1);
  return rows[0] ? mapFeedback(rows[0]) : null;
}
