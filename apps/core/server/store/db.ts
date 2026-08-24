import "server-only";

import { getProcessPool } from "@assistant-hub/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as storeSchema from "../../store/schema";
import { requireEnv } from "@/server/env";

/**
 * The v2 core store's shared database handle (assistants, per-assistant
 * tasks, job markers, turn actions, person links — `store/schema.ts`).
 * Grown out of the `server/turn/actions.ts` pool as Phase 3 gives the
 * store more residents than the turn markers; the pool key is the same
 * process-global one, so both entries share one pool per process.
 *
 * Transitional beside the v1 `@/db/drizzle` handle until the Phase 6
 * cutover collapses `STORE_DATABASE_URL` into `DATABASE_URL`.
 */

const POOL_KEY = Symbol.for("assistant-hub.core.store.pool");

/** The raw pool (SQL-level residents like the turn markers). */
export function getStorePool(): Pool {
  return getProcessPool(POOL_KEY, () => requireEnv("STORE_DATABASE_URL"));
}

export type StoreDb = ReturnType<typeof drizzle<typeof storeSchema>>;

const DB_KEY = Symbol.for("assistant-hub.core.store.drizzle");

/** The typed drizzle handle over the store schema (feature repositories). */
export function getStoreDb(): StoreDb {
  const g = globalThis as typeof globalThis & { [DB_KEY]?: StoreDb };
  if (!g[DB_KEY]) g[DB_KEY] = drizzle(getStorePool(), { schema: storeSchema });
  return g[DB_KEY];
}
