import { closeProcessPool, getProcessPool } from "@assistant-hub/db";
import { requireEnv } from "@assistant-hub/service";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../store/schema";

/** The tg store's Drizzle handle — this app's OWN database. */
export type TgDb = NodePgDatabase<typeof schema>;

const POOL_KEY = Symbol.for("assistant-hub.tg.db.pool");

let db: TgDb | null = null;

export function getTgDb(): TgDb {
  if (!db) {
    db = drizzle(getProcessPool(POOL_KEY, () => requireEnv("DATABASE_URL")), { schema });
  }
  return db;
}

/** Close the pool (graceful shutdown / tests). */
export async function closeTgDb(): Promise<void> {
  db = null;
  await closeProcessPool(POOL_KEY);
}
