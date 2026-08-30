import { and, asc, eq, sql } from "drizzle-orm";

import { connections, settings, type ConnectionRow } from "../store/schema";
import type { TgDb } from "./db";

/**
 * The one storage this app still keeps after the Phase 7 de-storing: the
 * telegram connections (bot token per assistant — desired state the bot
 * manager reconciles from) and the owner identity. Both move into the core's
 * transport config with the registration slice; everything conversational
 * left for the core's conversation store.
 */

/** Enabled telegram connections — what the reconciler runs pollers for. */
export async function listEnabledConnections(db: TgDb): Promise<ConnectionRow[]> {
  return db.select().from(connections).where(eq(connections.enabled, true));
}

/** All connections, oldest first (the operator listing). */
export async function listConnections(db: TgDb): Promise<ConnectionRow[]> {
  return db.select().from(connections).orderBy(asc(connections.createdAt));
}

export async function getConnection(db: TgDb, id: string): Promise<ConnectionRow | null> {
  const rows = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Create one connection (one bot per assistant — the unique index enforces it). */
export async function insertConnection(
  db: TgDb,
  values: { id: string; assistantId: string; botToken: string; enabled: boolean },
): Promise<ConnectionRow> {
  const rows = await db.insert(connections).values(values).returning();
  return rows[0];
}

/** Update a connection's desired state. Null when the connection is unknown. */
export async function updateConnection(
  db: TgDb,
  id: string,
  values: { botToken?: string; enabled?: boolean },
): Promise<ConnectionRow | null> {
  const rows = await db
    .update(connections)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(connections.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Delete a connection. Null when it was already gone. */
export async function deleteConnection(db: TgDb, id: string): Promise<ConnectionRow | null> {
  const rows = await db.delete(connections).where(eq(connections.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Delete every connection keyed on one assistant (the `assistant.deleted`
 * reaction). Returns the deleted rows so the caller can stop their pollers.
 */
export async function deleteConnectionsByAssistant(
  db: TgDb,
  assistantId: string,
): Promise<ConnectionRow[]> {
  return db.delete(connections).where(eq(connections.assistantId, assistantId)).returning();
}

/**
 * Set (or clear) the owner identity. A caller that already knows the
 * numeric id passes it; otherwise changing the @username resets the resolved
 * id — the new owner is re-resolved on their first message.
 */
export async function setOwner(
  db: TgDb,
  input: { ownerUsername: string | null; ownerUserId?: string | null },
): Promise<void> {
  const current = await getTgSettings(db);
  const normalized = input.ownerUsername?.trim().replace(/^@/, "").toLowerCase() || null;
  const ownerUserId =
    input.ownerUserId !== undefined
      ? input.ownerUserId
      : normalized !== current.ownerUsername
        ? null
        : current.ownerUserId;
  await db
    .update(settings)
    .set({ ownerUsername: normalized, ownerUserId, updatedAt: new Date() })
    .where(eq(settings.id, "singleton"));
}

/** This app's settings singleton, created empty on first read. */
export async function getTgSettings(
  db: TgDb,
): Promise<{ ownerUsername: string | null; ownerUserId: string | null }> {
  const rows = await db.select().from(settings).where(eq(settings.id, "singleton")).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(settings).values({ id: "singleton" }).onConflictDoNothing();
  return { ownerUsername: null, ownerUserId: null };
}

/**
 * Persist the owner's resolved numeric id, the first time the configured
 * @username messages a bot (Telegram has no lookup by username).
 */
export async function setResolvedOwnerUserId(db: TgDb, ownerUserId: string): Promise<void> {
  await db
    .update(settings)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(and(eq(settings.id, "singleton"), sql`${settings.ownerUserId} IS NULL`));
}
