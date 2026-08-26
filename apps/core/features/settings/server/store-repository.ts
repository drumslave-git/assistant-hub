import "server-only";

import { eq } from "drizzle-orm";

import { settings as storeSettings } from "../../../store/schema";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * The half of the settings row that already lives in the **v2 core store**.
 *
 * Settings as a whole stay on the v1 database until the Phase 6 cutover, but
 * a setting with no v1 column has no reason to be born there and migrated
 * again — so anything Phase 3 adds is written here, in the row the cutover
 * keeps. Same singleton convention as the v1 table; same "pure data access"
 * rule as every other repository (policy and tracing belong to the service,
 * which presents both halves as one Settings view).
 *
 * Reads are per call and uncached: this row is read once per settings page
 * load and once per cross-fed turn, not on every message the way the v1
 * record is.
 */

/** Fixed primary key of the one row (enforced by a DB check constraint). */
export const STORE_SETTINGS_ID = "singleton";

/** The store-owned settings, with the column defaults applied. */
export interface StoreSettingsRecord {
  /**
   * Bot-to-bot loop guard: consecutive assistant turns a chat may hold
   * before every assistant there falls silent until a human speaks.
   */
  assistantLoopGuardTurns: number;
}

/** Columns a write may touch. Undefined = leave unchanged. */
export interface StoreSettingsPatch {
  assistantLoopGuardTurns?: number;
}

/** The default every reader falls back to before the row is ever written. */
export const STORE_SETTINGS_DEFAULTS: StoreSettingsRecord = {
  // User decision, 2026-08-24.
  assistantLoopGuardTurns: 3,
};

/** The store-owned settings; defaults when the row does not exist yet. */
export async function getStoreSettings(
  db: StoreDb = getStoreDb(),
): Promise<StoreSettingsRecord> {
  const row = await db.query.settings.findFirst({
    where: eq(storeSettings.id, STORE_SETTINGS_ID),
  });
  if (!row) return { ...STORE_SETTINGS_DEFAULTS };
  return { assistantLoopGuardTurns: row.assistantLoopGuardTurns };
}

/** Upsert a patch onto the single row. Returns the full, updated record. */
export async function upsertStoreSettings(
  patch: StoreSettingsPatch,
  db: StoreDb = getStoreDb(),
): Promise<StoreSettingsRecord> {
  const changed = { ...patch, updatedAt: new Date() };
  const [row] = await db
    .insert(storeSettings)
    .values({ id: STORE_SETTINGS_ID, ...changed })
    .onConflictDoUpdate({ target: storeSettings.id, set: changed })
    .returning();
  return { assistantLoopGuardTurns: row.assistantLoopGuardTurns };
}
