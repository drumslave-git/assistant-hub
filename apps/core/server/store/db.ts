import "server-only";

import { closeProcessPool, getProcessPool } from "@assistant-hub-swarm/db";
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
 * cutover collapses `DATABASE_URL` into `DATABASE_URL`.
 */

const POOL_KEY = Symbol.for("assistant-hub-swarm.core.store.pool");

/** The raw pool (SQL-level residents like the turn markers). */
export function getStorePool(): Pool {
  return getProcessPool(POOL_KEY, () => requireEnv("DATABASE_URL"));
}

export type StoreDb = ReturnType<typeof drizzle<typeof storeSchema>>;

const DB_KEY = Symbol.for("assistant-hub-swarm.core.store.drizzle");
const SCHEMA_KEY = Symbol.for("assistant-hub-swarm.core.store.drizzle.schema");

/**
 * Which tables the loaded schema defines. A drizzle handle binds its query
 * builders at construction, and this one is cached on `globalThis` so it
 * survives module re-evaluation — which in dev means a handle built before a
 * new table existed keeps serving `db.query.<newTable> === undefined`, and
 * the page that reads it dies on "cannot read properties of undefined". Same
 * class of staleness as the MCP registry's (`server/mcp/runtime.ts`), same
 * answer: notice and rebuild rather than require a restart.
 */
const schemaFingerprint = Object.keys(storeSchema).sort().join(",");

/** The typed drizzle handle over the store schema (feature repositories). */
export function getStoreDb(): StoreDb {
  const g = globalThis as typeof globalThis & {
    [DB_KEY]?: StoreDb;
    [SCHEMA_KEY]?: string;
  };
  if (!g[DB_KEY] || g[SCHEMA_KEY] !== schemaFingerprint) {
    g[DB_KEY] = drizzle(getStorePool(), { schema: storeSchema });
    g[SCHEMA_KEY] = schemaFingerprint;
  }
  return g[DB_KEY];
}

/**
 * Close the shared store pool and drop the cached handle (graceful shutdown /
 * test teardown — a suite that let production code open this pool must close
 * it before its Testcontainer stops, or the dying clients fail the run).
 */
export async function closeStorePool(): Promise<void> {
  const g = globalThis as typeof globalThis & {
    [DB_KEY]?: StoreDb;
    [SCHEMA_KEY]?: string;
  };
  delete g[DB_KEY];
  delete g[SCHEMA_KEY];
  await closeProcessPool(POOL_KEY);
}
