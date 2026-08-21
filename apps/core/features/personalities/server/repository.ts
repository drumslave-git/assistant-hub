import "server-only";

import { asc, eq, ne, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { personalities, type PersonalityRow } from "@/db/schema";

/**
 * Typed persistence for personalities. Pure data access: no policy, no
 * validation, no trace recording (the service owns those). Every function takes a
 * {@link DrizzleDb} so it runs against the pool or a test instance.
 */

/** A personality as stored. */
export interface PersonalityRecord {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

/** Columns a create/update may set. */
export interface PersonalityValues {
  name: string;
  prompt: string;
}

function mapRow(row: PersonalityRow): PersonalityRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All personalities, oldest first (stable creation order). */
export async function listPersonalities(db: DrizzleDb): Promise<PersonalityRecord[]> {
  const rows = await db.query.personalities.findMany({ orderBy: [asc(personalities.createdAt)] });
  return rows.map(mapRow);
}

/** One personality by id, or null. */
export async function getPersonalityById(
  db: DrizzleDb,
  id: string,
): Promise<PersonalityRecord | null> {
  const row = await db.query.personalities.findFirst({ where: eq(personalities.id, id) });
  return row ? mapRow(row) : null;
}

/** Total number of personalities (for the max-count guard). */
export async function countPersonalities(db: DrizzleDb): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(personalities);
  return rows[0]?.n ?? 0;
}

/**
 * Whether a name is already taken (case-insensitive), optionally excluding one
 * id (for renames). Names are unique per operator convenience, not by DB
 * constraint, so this check is the source of truth.
 */
export async function isNameTaken(
  db: DrizzleDb,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const lowerMatch = sql`lower(${personalities.name}) = lower(${name})`;
  const where = exceptId ? sql`${lowerMatch} and ${ne(personalities.id, exceptId)}` : lowerMatch;
  const rows = await db.select({ id: personalities.id }).from(personalities).where(where).limit(1);
  return rows.length > 0;
}

/** Insert a personality with an app-generated id. Returns the stored record. */
export async function insertPersonality(
  db: DrizzleDb,
  id: string,
  values: PersonalityValues,
): Promise<PersonalityRecord> {
  const now = new Date();
  const [row] = await db
    .insert(personalities)
    .values({ id, name: values.name, prompt: values.prompt, createdAt: now, updatedAt: now })
    .returning();
  return mapRow(row);
}

/** Apply a patch to one personality. Returns the updated record, or null if unknown. */
export async function updatePersonality(
  db: DrizzleDb,
  id: string,
  patch: Partial<PersonalityValues>,
): Promise<PersonalityRecord | null> {
  const [row] = await db
    .update(personalities)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(personalities.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/** Delete one personality. Returns true if a row was removed. */
export async function deletePersonality(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(personalities).where(eq(personalities.id, id)).returning({
    id: personalities.id,
  });
  return rows.length > 0;
}
