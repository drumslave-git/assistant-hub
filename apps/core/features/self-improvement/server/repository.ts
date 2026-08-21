import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import {
  selfCorrections,
  usersCommunicationPreferences,
  usersFeedbacks,
  type SelfCorrectionRow,
  type UsersCommunicationPreferenceRow,
  type UsersFeedbackRow,
} from "@/db/schema";
import type {
  CommunicationPreference,
  FeedbackReaction,
  FeedbackStatus,
  FeedbackTopic,
  SelfCorrection,
  UserFeedback,
} from "../types";

/**
 * Data access for the self-improvement feature: feedback rows collected from
 * 👍/👎 reactions, versioned per-user communication preferences, and versioned
 * global self-corrections. Pure data access — traces and flow logic live in the
 * service.
 */

function mapFeedback(row: UsersFeedbackRow): UserFeedback {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    userId: row.userId,
    reaction: row.reaction === "up" ? "up" : "down",
    feedback: row.feedback,
    status: (["pending", "awaiting_text", "completed"] as const).includes(
      row.status as FeedbackStatus,
    )
      ? (row.status as FeedbackStatus)
      : "pending",
    topic: row.topic === "addressing" ? "addressing" : "quality",
    model: row.model,
    reflection: row.reflection,
    reflectionModel: row.reflectionModel,
    prefsVersion: row.prefsVersion,
    correctionsVersion: row.correctionsVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapPreference(row: UsersCommunicationPreferenceRow): CommunicationPreference {
  return {
    id: row.id,
    userId: row.userId,
    model: row.model,
    likes: row.likes,
    dislikes: row.dislikes,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCorrection(row: SelfCorrectionRow): SelfCorrection {
  return {
    id: row.id,
    model: row.model,
    correction: row.correction,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A fresh reaction to record (or re-record). */
export interface UpsertFeedback {
  id: string;
  chatId: string;
  telegramMessageId: number;
  userId: string;
  reaction: FeedbackReaction;
  /** Clean model name that generated the reacted reply. */
  model: string;
}

/**
 * Record a reaction: insert a `pending` feedback row, or — when this user
 * already reacted to this message — reopen the existing row (new reaction,
 * status back to `pending`, previous answer, reflection and incorporation stamps
 * cleared) so a repeat reaction asks again and the fresh answer is reflected on
 * and picked up by the next incorporation run.
 */
export async function upsertFeedback(db: DrizzleDb, values: UpsertFeedback): Promise<UserFeedback> {
  const [row] = await db
    .insert(usersFeedbacks)
    .values({
      id: values.id,
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      userId: values.userId,
      reaction: values.reaction,
      model: values.model,
    })
    .onConflictDoUpdate({
      target: [usersFeedbacks.chatId, usersFeedbacks.telegramMessageId, usersFeedbacks.userId],
      set: {
        reaction: values.reaction,
        model: values.model,
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
export async function getFeedback(db: DrizzleDb, id: string): Promise<UserFeedback | null> {
  const row = await db.query.usersFeedbacks.findFirst({ where: eq(usersFeedbacks.id, id) });
  return row ? mapFeedback(row) : null;
}

/** Remember the menu message we sent for a feedback row. */
export async function setFeedbackMenuMessage(
  db: DrizzleDb,
  id: string,
  menuMessageId: number,
): Promise<void> {
  await db
    .update(usersFeedbacks)
    .set({ menuMessageId, updatedAt: sql`now()` })
    .where(eq(usersFeedbacks.id, id));
}

/**
 * Store the user's answer and complete the row. `topic` records what the answer
 * is about (see {@link FeedbackTopic}) — it decides whether the daily folds read
 * this row at all, so it is written with the answer rather than derived later.
 * Returns the updated record.
 */
export async function completeFeedback(
  db: DrizzleDb,
  id: string,
  feedback: string,
  topic: FeedbackTopic = "quality",
): Promise<UserFeedback | null> {
  const [row] = await db
    .update(usersFeedbacks)
    .set({ feedback, topic, status: "completed", updatedAt: sql`now()` })
    .where(eq(usersFeedbacks.id, id))
    .returning();
  return row ? mapFeedback(row) : null;
}

/** Store the bot's self-reflection on an answered feedback. */
export async function setFeedbackReflection(
  db: DrizzleDb,
  id: string,
  reflection: string,
  reflectionModel: string,
): Promise<void> {
  await db
    .update(usersFeedbacks)
    .set({ reflection, reflectionModel, updatedAt: sql`now()` })
    .where(eq(usersFeedbacks.id, id));
}

/** Flip a row to `awaiting_text` ("Other" tapped — a reply will carry the answer). */
export async function markFeedbackAwaitingText(db: DrizzleDb, id: string): Promise<void> {
  await db
    .update(usersFeedbacks)
    .set({ status: "awaiting_text", updatedAt: sql`now()` })
    .where(eq(usersFeedbacks.id, id));
}

/**
 * The `awaiting_text` feedback whose menu message the given user replied to, or
 * null. Backs the free-text capture: a reply to the menu from the reactor is the
 * feedback answer, not a normal bot turn.
 */
export async function findAwaitingFeedbackByMenu(
  db: DrizzleDb,
  chatId: string,
  menuMessageId: number,
  userId: string,
): Promise<UserFeedback | null> {
  const row = await db.query.usersFeedbacks.findFirst({
    where: and(
      eq(usersFeedbacks.chatId, chatId),
      eq(usersFeedbacks.menuMessageId, menuMessageId),
      eq(usersFeedbacks.userId, userId),
      eq(usersFeedbacks.status, "awaiting_text"),
    ),
  });
  return row ? mapFeedback(row) : null;
}

/** All feedback rows, newest first (dashboard). */
export async function listFeedbacks(db: DrizzleDb): Promise<UserFeedback[]> {
  const rows = await db
    .select()
    .from(usersFeedbacks)
    .orderBy(desc(usersFeedbacks.createdAt));
  return rows.map(mapFeedback);
}

/**
 * Completed **quality** feedbacks not yet folded into a preferences version,
 * oldest first. `addressing` rows are deliberately invisible to both folds — see
 * {@link FeedbackTopic}. They are not left "pending" by this: nothing ever stamps
 * them, and nothing is meant to.
 */
export async function listUnincorporatedForPrefs(db: DrizzleDb): Promise<UserFeedback[]> {
  const rows = await db
    .select()
    .from(usersFeedbacks)
    .where(
      and(
        eq(usersFeedbacks.status, "completed"),
        eq(usersFeedbacks.topic, "quality"),
        isNull(usersFeedbacks.prefsVersion),
      ),
    )
    .orderBy(usersFeedbacks.createdAt);
  return rows.map(mapFeedback);
}

/** Completed quality feedbacks not yet folded into a corrections version, oldest first. */
export async function listUnincorporatedForCorrections(db: DrizzleDb): Promise<UserFeedback[]> {
  const rows = await db
    .select()
    .from(usersFeedbacks)
    .where(
      and(
        eq(usersFeedbacks.status, "completed"),
        eq(usersFeedbacks.topic, "quality"),
        isNull(usersFeedbacks.correctionsVersion),
      ),
    )
    .orderBy(usersFeedbacks.createdAt);
  return rows.map(mapFeedback);
}

/** Stamp the preferences version that incorporated the given feedbacks. */
export async function stampPrefsVersion(
  db: DrizzleDb,
  ids: string[],
  version: number,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(usersFeedbacks)
    .set({ prefsVersion: version, updatedAt: sql`now()` })
    .where(inArray(usersFeedbacks.id, ids));
}

/** Stamp the corrections version that incorporated the given feedbacks. */
export async function stampCorrectionsVersion(
  db: DrizzleDb,
  ids: string[],
  version: number,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(usersFeedbacks)
    .set({ correctionsVersion: version, updatedAt: sql`now()` })
    .where(inArray(usersFeedbacks.id, ids));
}

/** The latest preferences version for a user, or null. */
export async function getLatestPreference(
  db: DrizzleDb,
  userId: string,
): Promise<CommunicationPreference | null> {
  const row = await db.query.usersCommunicationPreferences.findFirst({
    where: eq(usersCommunicationPreferences.userId, userId),
    orderBy: (p, { desc: d }) => [d(p.version)],
  });
  return row ? mapPreference(row) : null;
}

/** The latest preferences version per user (dashboard). */
export async function listLatestPreferences(db: DrizzleDb): Promise<CommunicationPreference[]> {
  const rows = await db
    .select()
    .from(usersCommunicationPreferences)
    .orderBy(desc(usersCommunicationPreferences.version));
  const latest = new Map<string, UsersCommunicationPreferenceRow>();
  for (const row of rows) {
    if (!latest.has(row.userId)) latest.set(row.userId, row);
  }
  return [...latest.values()].map(mapPreference);
}

/** Append a new preferences version for a user. */
export async function insertPreference(
  db: DrizzleDb,
  values: {
    id: string;
    userId: string;
    model: string;
    likes: string;
    dislikes: string;
    version: number;
  },
): Promise<CommunicationPreference> {
  const [row] = await db.insert(usersCommunicationPreferences).values(values).returning();
  return mapPreference(row);
}

/** The latest self-correction version, or null. */
export async function getLatestCorrection(db: DrizzleDb): Promise<SelfCorrection | null> {
  const row = await db.query.selfCorrections.findFirst({
    orderBy: (c, { desc: d }) => [d(c.version)],
  });
  return row ? mapCorrection(row) : null;
}

/** Append a new global self-correction version. */
export async function insertCorrection(
  db: DrizzleDb,
  values: { id: string; model: string; correction: string; version: number },
): Promise<SelfCorrection> {
  const [row] = await db.insert(selfCorrections).values(values).returning();
  return mapCorrection(row);
}
