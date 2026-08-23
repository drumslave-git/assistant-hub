import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { feedbacks, type FeedbackRow } from "../../store/schema";
import type { TgDb } from "../db";
import type { FeedbackReaction, FeedbackTopic } from "./menu";

/**
 * Feedback rows in this app's store — the tg half of the v1 self-improvement
 * repository (`usersFeedbacks`), covering what the collection flows touch.
 * The distilled outputs (preferences, corrections) and the reflection/fold
 * write-backs stay core-side; the core reaches these rows through the
 * internal API and hears about completions on the bus.
 */

export interface FeedbackRecord {
  id: string;
  chatId: string;
  telegramMessageId: number;
  userId: string;
  reaction: FeedbackReaction;
  feedback: string | null;
  status: "pending" | "awaiting_text" | "completed";
  topic: FeedbackTopic;
  menuMessageId: number | null;
  /** Clean model name of the reacted reply — stamped by the core (write-back). */
  model: string | null;
  reflection: string | null;
  reflectionModel: string | null;
  prefsVersion: number | null;
  correctionsVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapFeedback(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    userId: row.userId,
    reaction: row.reaction === "up" ? "up" : "down",
    feedback: row.feedback,
    status: (["pending", "awaiting_text", "completed"] as const).includes(
      row.status as FeedbackRecord["status"],
    )
      ? (row.status as FeedbackRecord["status"])
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
 * reflected on and picked up by the next incorporation run (v1 semantics).
 * `model` stays null here — the core stamps it on write-back, since only it
 * can read the reply trace that knows which model answered.
 */
export async function upsertFeedback(
  db: TgDb,
  values: {
    id: string;
    chatId: string;
    telegramMessageId: number;
    userId: string;
    reaction: FeedbackReaction;
  },
): Promise<FeedbackRecord> {
  const [row] = await db
    .insert(feedbacks)
    .values(values)
    .onConflictDoUpdate({
      target: [feedbacks.chatId, feedbacks.telegramMessageId, feedbacks.userId],
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
export async function getFeedback(db: TgDb, id: string): Promise<FeedbackRecord | null> {
  const rows = await db.select().from(feedbacks).where(eq(feedbacks.id, id)).limit(1);
  return rows[0] ? mapFeedback(rows[0]) : null;
}

/** Remember the menu message we sent for a feedback row. */
export async function setFeedbackMenuMessage(
  db: TgDb,
  id: string,
  menuMessageId: number,
): Promise<void> {
  await db
    .update(feedbacks)
    .set({ menuMessageId, updatedAt: sql`now()` })
    .where(eq(feedbacks.id, id));
}

/**
 * Store the user's answer and complete the row. `topic` records what the
 * answer is about — it decides whether the core's daily folds read this row
 * at all, so it is written with the answer rather than derived later.
 */
export async function completeFeedback(
  db: TgDb,
  id: string,
  feedback: string,
  topic: FeedbackTopic = "quality",
): Promise<FeedbackRecord | null> {
  const [row] = await db
    .update(feedbacks)
    .set({ feedback, topic, status: "completed", updatedAt: sql`now()` })
    .where(eq(feedbacks.id, id))
    .returning();
  return row ? mapFeedback(row) : null;
}

/** Flip a row to `awaiting_text` ("Other" tapped — a reply will carry the answer). */
export async function markFeedbackAwaitingText(db: TgDb, id: string): Promise<void> {
  await db
    .update(feedbacks)
    .set({ status: "awaiting_text", updatedAt: sql`now()` })
    .where(eq(feedbacks.id, id));
}

/** All feedback rows, newest first (the dashboard listing). */
export async function listFeedbacks(db: TgDb): Promise<FeedbackRecord[]> {
  const rows = await db.select().from(feedbacks).orderBy(desc(feedbacks.createdAt));
  return rows.map(mapFeedback);
}

/**
 * Completed **quality** feedbacks the given fold has not incorporated yet,
 * oldest first (v1 `listUnincorporatedFor*`). `addressing` rows are
 * deliberately invisible to both folds — nothing ever stamps them, and
 * nothing is meant to.
 */
export async function listUnincorporatedFeedbacks(
  db: TgDb,
  kind: "prefs" | "corrections",
): Promise<FeedbackRecord[]> {
  const versionColumn = kind === "prefs" ? feedbacks.prefsVersion : feedbacks.correctionsVersion;
  const rows = await db
    .select()
    .from(feedbacks)
    .where(
      and(
        eq(feedbacks.status, "completed"),
        eq(feedbacks.topic, "quality"),
        isNull(versionColumn),
      ),
    )
    .orderBy(asc(feedbacks.createdAt));
  return rows.map(mapFeedback);
}

/**
 * Apply a core write-back (model / reflection / fold-version stamps). Null
 * when the row is unknown.
 */
export async function patchFeedback(
  db: TgDb,
  id: string,
  patch: {
    model?: string;
    reflection?: string;
    reflectionModel?: string;
    prefsVersion?: number;
    correctionsVersion?: number;
  },
): Promise<FeedbackRecord | null> {
  const rows = await db
    .update(feedbacks)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(feedbacks.id, id))
    .returning();
  return rows[0] ? mapFeedback(rows[0]) : null;
}

/**
 * The `awaiting_text` feedback whose menu message the given user replied to,
 * or null. Backs the free-text capture: a reply to the menu from the reactor
 * is the feedback answer, not a normal bot turn.
 */
export async function findAwaitingFeedbackByMenu(
  db: TgDb,
  chatId: string,
  menuMessageId: number,
  userId: string,
): Promise<FeedbackRecord | null> {
  const rows = await db
    .select()
    .from(feedbacks)
    .where(
      and(
        eq(feedbacks.chatId, chatId),
        eq(feedbacks.menuMessageId, menuMessageId),
        eq(feedbacks.userId, userId),
        eq(feedbacks.status, "awaiting_text"),
      ),
    )
    .limit(1);
  return rows[0] ? mapFeedback(rows[0]) : null;
}
