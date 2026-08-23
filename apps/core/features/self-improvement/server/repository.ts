import "server-only";

import { desc, eq } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import {
  selfCorrections,
  usersCommunicationPreferences,
  type SelfCorrectionRow,
  type UsersCommunicationPreferenceRow,
} from "@/db/schema";
import type { CommunicationPreference, SelfCorrection } from "../types";

/**
 * Data access for the self-improvement feature's distilled outputs:
 * versioned per-user communication preferences and versioned
 * global self-corrections. Pure data access — traces and flow logic live in the
 * service.
 */

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
