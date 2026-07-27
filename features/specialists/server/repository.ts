import "server-only";

import { and, asc, desc, eq, ne, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import {
  chatSpecialists,
  specialistEntries,
  specialists,
  type ChatSpecialistRow,
  type SpecialistEntryRow,
  type SpecialistRow,
} from "@/db/schema";
import type { DataScope } from "./schema";

/**
 * Typed persistence for specialists, their per-chat activations, and the
 * unified entry store. Pure data access: no policy, no validation, no trace
 * recording (the service owns those). Every function takes a {@link DrizzleDb}
 * so it runs against the pool or a test instance.
 */

/** A specialist as stored. */
export interface SpecialistRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  dataScope: DataScope;
  createdAt: string;
  updatedAt: string;
}

/** Columns a create/update may set. */
export interface SpecialistValues {
  name: string;
  description: string;
  instructions: string;
  dataScope: DataScope;
}

function mapRow(row: SpecialistRow): SpecialistRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    dataScope: row.dataScope as DataScope,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All specialists, oldest first (stable creation order — seeds stay on top). */
export async function listSpecialists(db: DrizzleDb): Promise<SpecialistRecord[]> {
  const rows = await db.query.specialists.findMany({ orderBy: [asc(specialists.createdAt)] });
  return rows.map(mapRow);
}

/** One specialist by id, or null. */
export async function getSpecialistById(
  db: DrizzleDb,
  id: string,
): Promise<SpecialistRecord | null> {
  const row = await db.query.specialists.findFirst({ where: eq(specialists.id, id) });
  return row ? mapRow(row) : null;
}

/** One specialist by name (case-insensitive), or null. */
export async function getSpecialistByName(
  db: DrizzleDb,
  name: string,
): Promise<SpecialistRecord | null> {
  const rows = await db
    .select()
    .from(specialists)
    .where(sql`lower(${specialists.name}) = lower(${name})`)
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Total number of specialists (for the max-count guard). */
export async function countSpecialists(db: DrizzleDb): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(specialists);
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
  const lowerMatch = sql`lower(${specialists.name}) = lower(${name})`;
  const where = exceptId ? sql`${lowerMatch} and ${ne(specialists.id, exceptId)}` : lowerMatch;
  const rows = await db.select({ id: specialists.id }).from(specialists).where(where).limit(1);
  return rows.length > 0;
}

/** Insert a specialist with an app-generated id. Returns the stored record. */
export async function insertSpecialist(
  db: DrizzleDb,
  id: string,
  values: SpecialistValues,
): Promise<SpecialistRecord> {
  const now = new Date();
  const [row] = await db
    .insert(specialists)
    .values({ id, ...values, createdAt: now, updatedAt: now })
    .returning();
  return mapRow(row);
}

/** Apply a patch to one specialist. Returns the updated record, or null if unknown. */
export async function updateSpecialist(
  db: DrizzleDb,
  id: string,
  patch: Partial<SpecialistValues>,
): Promise<SpecialistRecord | null> {
  const [row] = await db
    .update(specialists)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(specialists.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/** Delete one specialist. Returns true if a row was removed (activations cascade). */
export async function deleteSpecialist(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(specialists).where(eq(specialists.id, id)).returning({
    id: specialists.id,
  });
  return rows.length > 0;
}

/* ----------------------------- chat activation ----------------------------- */

/** One chat's activation as stored. */
export interface ChatSpecialistRecord {
  chatId: string;
  specialistId: string;
  activatedByUserId: string | null;
  updatedAt: string;
}

function mapAssignmentRow(row: ChatSpecialistRow): ChatSpecialistRecord {
  return {
    chatId: row.chatId,
    specialistId: row.specialistId,
    activatedByUserId: row.activatedByUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every chat→specialist activation. */
export async function listChatSpecialists(db: DrizzleDb): Promise<ChatSpecialistRecord[]> {
  const rows = await db.query.chatSpecialists.findMany({
    orderBy: [desc(chatSpecialists.updatedAt)],
  });
  return rows.map(mapAssignmentRow);
}

/** The activation for one chat, or null (no specialist active). */
export async function getChatSpecialist(
  db: DrizzleDb,
  chatId: string,
): Promise<ChatSpecialistRecord | null> {
  const row = await db.query.chatSpecialists.findFirst({
    where: eq(chatSpecialists.chatId, chatId),
  });
  return row ? mapAssignmentRow(row) : null;
}

/** Set (upsert) one chat's active specialist. */
export async function upsertChatSpecialist(
  db: DrizzleDb,
  values: { chatId: string; specialistId: string; activatedByUserId: string | null },
): Promise<ChatSpecialistRecord> {
  const now = new Date();
  const [row] = await db
    .insert(chatSpecialists)
    .values({ ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: chatSpecialists.chatId,
      set: {
        specialistId: values.specialistId,
        activatedByUserId: values.activatedByUserId,
        updatedAt: now,
      },
    })
    .returning();
  return mapAssignmentRow(row);
}

/** Clear one chat's activation (back to the no-specialist default). */
export async function deleteChatSpecialist(db: DrizzleDb, chatId: string): Promise<boolean> {
  const rows = await db
    .delete(chatSpecialists)
    .where(eq(chatSpecialists.chatId, chatId))
    .returning({ chatId: chatSpecialists.chatId });
  return rows.length > 0;
}

/* -------------------------------- entries --------------------------------- */

/** A stored entry. */
export interface SpecialistEntryRecord {
  id: string;
  specialistId: string;
  chatId: string;
  authorUserId: string | null;
  collection: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function mapEntryRow(row: SpecialistEntryRow): SpecialistEntryRecord {
  return {
    id: row.id,
    specialistId: row.specialistId,
    chatId: row.chatId,
    authorUserId: row.authorUserId,
    collection: row.collection,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The toolkit's read scope: `per-chat` filters on (specialist, chat); `shared`
 * on the specialist alone. Built by the service from the specialist's flag.
 */
export interface EntryScope {
  specialistId: string;
  /** Present for `per-chat` scope; absent for `shared`. */
  chatId?: string;
}

function scopeWhere(scope: EntryScope) {
  return scope.chatId
    ? and(
        eq(specialistEntries.specialistId, scope.specialistId),
        eq(specialistEntries.chatId, scope.chatId),
      )
    : eq(specialistEntries.specialistId, scope.specialistId);
}

/** Insert one entry. Returns the stored record. */
export async function insertEntry(
  db: DrizzleDb,
  id: string,
  values: {
    specialistId: string;
    chatId: string;
    authorUserId: string | null;
    collection: string;
    payload: Record<string, unknown>;
  },
): Promise<SpecialistEntryRecord> {
  const now = new Date();
  const [row] = await db
    .insert(specialistEntries)
    .values({ id, ...values, createdAt: now, updatedAt: now })
    .returning();
  return mapEntryRow(row);
}

/** One entry by id *within a scope*, or null — a tool can never cross scopes. */
export async function getEntryInScope(
  db: DrizzleDb,
  scope: EntryScope,
  id: string,
): Promise<SpecialistEntryRecord | null> {
  const row = await db.query.specialistEntries.findFirst({
    where: and(eq(specialistEntries.id, id), scopeWhere(scope)),
  });
  return row ? mapEntryRow(row) : null;
}

/**
 * Entries in a scope, newest first, optionally narrowed to one collection
 * and/or a case-insensitive substring of the payload's JSON text.
 */
export async function queryEntries(
  db: DrizzleDb,
  scope: EntryScope,
  filter: { collection?: string; contains?: string; limit: number },
): Promise<SpecialistEntryRecord[]> {
  const parts = [scopeWhere(scope)];
  if (filter.collection) parts.push(eq(specialistEntries.collection, filter.collection));
  if (filter.contains) {
    parts.push(sql`${specialistEntries.payload}::text ilike ${"%" + filter.contains + "%"}`);
  }
  const rows = await db
    .select()
    .from(specialistEntries)
    .where(and(...parts))
    .orderBy(desc(specialistEntries.createdAt))
    .limit(filter.limit);
  return rows.map(mapEntryRow);
}

/** Distinct collection labels in a scope (for the list result + dashboard filter). */
export async function listCollections(db: DrizzleDb, scope: EntryScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ collection: specialistEntries.collection })
    .from(specialistEntries)
    .where(scopeWhere(scope))
    .orderBy(asc(specialistEntries.collection));
  return rows.map((r) => r.collection);
}

/** Replace one entry's payload (within a scope). Returns the record, or null. */
export async function updateEntryInScope(
  db: DrizzleDb,
  scope: EntryScope,
  id: string,
  payload: Record<string, unknown>,
): Promise<SpecialistEntryRecord | null> {
  const [row] = await db
    .update(specialistEntries)
    .set({ payload, updatedAt: new Date() })
    .where(and(eq(specialistEntries.id, id), scopeWhere(scope)))
    .returning();
  return row ? mapEntryRow(row) : null;
}

/** Delete one entry (within a scope). Returns true if a row was removed. */
export async function deleteEntryInScope(
  db: DrizzleDb,
  scope: EntryScope,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(specialistEntries)
    .where(and(eq(specialistEntries.id, id), scopeWhere(scope)))
    .returning({ id: specialistEntries.id });
  return rows.length > 0;
}

/** Dashboard entries browser: latest entries across all scopes, with filters. */
export async function browseEntries(
  db: DrizzleDb,
  filter: { specialistId?: string; chatId?: string; collection?: string; limit: number },
): Promise<SpecialistEntryRecord[]> {
  const parts = [];
  if (filter.specialistId) parts.push(eq(specialistEntries.specialistId, filter.specialistId));
  if (filter.chatId) parts.push(eq(specialistEntries.chatId, filter.chatId));
  if (filter.collection) parts.push(eq(specialistEntries.collection, filter.collection));
  const rows = await db
    .select()
    .from(specialistEntries)
    .where(parts.length > 0 ? and(...parts) : undefined)
    .orderBy(desc(specialistEntries.createdAt))
    .limit(filter.limit);
  return rows.map(mapEntryRow);
}
