import "server-only";

import { desc, eq } from "drizzle-orm";

import type { StoreDb } from "@/server/store/db";

import {
  communicationPreferences,
  selfCorrections,
  type CommunicationPreferenceRow,
  type SelfCorrectionRow,
} from "../../../store/schema";
import type { CommunicationPreference, SelfCorrection } from "../types";

/**
 * Data access for the self-improvement feature's distilled outputs:
 * versioned per-user communication preferences and versioned
 * global self-corrections. Pure data access — traces and flow logic live in the
 * service.
 */

function mapPreference(row: CommunicationPreferenceRow): CommunicationPreference {
  return {
    id: row.id,
    userRef: row.userRef,
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

/** The latest preferences version for a person (by scoped ref), or null. */
export async function getLatestPreference(
  db: StoreDb,
  userRef: string,
): Promise<CommunicationPreference | null> {
  const row = await db.query.communicationPreferences.findFirst({
    where: eq(communicationPreferences.userRef, userRef),
    orderBy: (p, { desc: d }) => [d(p.version)],
  });
  return row ? mapPreference(row) : null;
}

/** The latest preferences version per user (dashboard). */
export async function listLatestPreferences(db: StoreDb): Promise<CommunicationPreference[]> {
  const rows = await db
    .select()
    .from(communicationPreferences)
    .orderBy(desc(communicationPreferences.version));
  const latest = new Map<string, CommunicationPreferenceRow>();
  for (const row of rows) {
    if (!latest.has(row.userRef)) latest.set(row.userRef, row);
  }
  return [...latest.values()].map(mapPreference);
}

/** Append a new preferences version for a user. */
export async function insertPreference(
  db: StoreDb,
  values: {
    id: string;
    userRef: string;
    model: string;
    likes: string;
    dislikes: string;
    version: number;
  },
): Promise<CommunicationPreference> {
  const [row] = await db.insert(communicationPreferences).values(values).returning();
  return mapPreference(row);
}

/** The latest self-correction version, or null. */
export async function getLatestCorrection(db: StoreDb): Promise<SelfCorrection | null> {
  const row = await db.query.selfCorrections.findFirst({
    orderBy: (c, { desc: d }) => [d(c.version)],
  });
  return row ? mapCorrection(row) : null;
}

/** Append a new global self-correction version. */
export async function insertCorrection(
  db: StoreDb,
  values: { id: string; model: string; correction: string; version: number },
): Promise<SelfCorrection> {
  const [row] = await db.insert(selfCorrections).values(values).returning();
  return mapCorrection(row);
}
