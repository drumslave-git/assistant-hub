import "server-only";

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { accounts, type AccountRow } from "../../store/schema";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * Typed persistence for accounts (redesign Phase 8). Pure data access over
 * the core store — no policy, no hashing, no trace recording (the auth and
 * account services own those). Every function takes a {@link StoreDb} so it
 * runs against the process pool or a test instance.
 */

export type { AccountRow };

/** Whether any account exists at all (drives the first-run /setup gate). */
export async function anyAccountExists(db: StoreDb = getStoreDb()): Promise<boolean> {
  const rows = await db.select({ id: accounts.id }).from(accounts).limit(1);
  return rows.length > 0;
}

/** One account by id, or null. */
export async function getAccountById(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return rows[0] ?? null;
}

/** One account by username (case-insensitive), or null. */
export async function getAccountByUsername(
  username: string,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(sql`lower(${accounts.username}) = lower(${username})`)
    .limit(1);
  return rows[0] ?? null;
}

/** All accounts, oldest first (the admin management list). */
export async function listAccounts(db: StoreDb = getStoreDb()): Promise<AccountRow[]> {
  return db.select().from(accounts).orderBy(accounts.createdAt);
}

/** Insert a new account row. */
export async function insertAccount(
  input: typeof accounts.$inferInsert,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow> {
  const rows = await db.insert(accounts).values(input).returning();
  return rows[0];
}

/** Patch an account row; returns the fresh row or null when it is unknown. */
export async function updateAccount(
  id: string,
  patch: Partial<typeof accounts.$inferInsert>,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db
    .update(accounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(accounts.id, id))
    .returning();
  return rows[0] ?? null;
}
