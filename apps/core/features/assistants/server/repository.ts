import "server-only";

import { asc, eq, ne, sql } from "drizzle-orm";

import { assistants, type AssistantRow } from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

/**
 * Typed persistence for assistants, over the v2 core store. Pure data
 * access: no policy, no validation, no trace recording (the service owns
 * those). Every function takes a {@link StoreDb} so it runs against the
 * process pool or a test instance.
 */

/** An assistant as stored. */
export interface AssistantRecord {
  id: string;
  name: string;
  persona: string;
  /** The owning account (Phase 8), or null for pre-auth rows (admin-owned). */
  ownerAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Columns a create/update may set. */
export interface AssistantValues {
  name: string;
  persona: string;
}

function mapRow(row: AssistantRow): AssistantRecord {
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    ownerAccountId: row.ownerAccountId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All assistants, oldest first (stable creation order). */
export async function listAssistants(db: StoreDb): Promise<AssistantRecord[]> {
  const rows = await db.query.assistants.findMany({ orderBy: [asc(assistants.createdAt)] });
  return rows.map(mapRow);
}

/** One assistant by id, or null. */
export async function getAssistantById(db: StoreDb, id: string): Promise<AssistantRecord | null> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, id) });
  return row ? mapRow(row) : null;
}

/** Total number of assistants (for the max-count guard). */
export async function countAssistants(db: StoreDb): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(assistants);
  return rows[0]?.n ?? 0;
}

/**
 * Whether a name is already taken (case-insensitive), optionally excluding
 * one id (for renames). Names are unique per operator convenience, not by DB
 * constraint, so this check is the source of truth.
 */
export async function isNameTaken(db: StoreDb, name: string, exceptId?: string): Promise<boolean> {
  const lowerMatch = sql`lower(${assistants.name}) = lower(${name})`;
  const where = exceptId ? sql`${lowerMatch} and ${ne(assistants.id, exceptId)}` : lowerMatch;
  const rows = await db.select({ id: assistants.id }).from(assistants).where(where).limit(1);
  return rows.length > 0;
}

/** Insert an assistant with an app-generated id. Returns the stored record. */
export async function insertAssistant(
  db: StoreDb,
  id: string,
  values: AssistantValues & { ownerAccountId: string | null },
): Promise<AssistantRecord> {
  const now = new Date();
  const [row] = await db
    .insert(assistants)
    .values({
      id,
      name: values.name,
      persona: values.persona,
      ownerAccountId: values.ownerAccountId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row);
}

/** Apply a patch to one assistant. Returns the updated record, or null if unknown. */
export async function updateAssistant(
  db: StoreDb,
  id: string,
  patch: Partial<AssistantValues>,
): Promise<AssistantRecord | null> {
  const [row] = await db
    .update(assistants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistants.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/** Delete one assistant (its tasks cascade). Returns true if a row was removed. */
export async function deleteAssistant(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db.delete(assistants).where(eq(assistants.id, id)).returning({
    id: assistants.id,
  });
  return rows.length > 0;
}
