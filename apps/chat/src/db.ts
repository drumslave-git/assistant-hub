import { closeProcessPool, getProcessPool } from "@assistant-hub/db";
import { requireEnv } from "@assistant-hub/service";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../store/schema";

/** The chat store's Drizzle handle — this app's OWN database. */
export type ChatDb = NodePgDatabase<typeof schema>;

const POOL_KEY = Symbol.for("assistant-hub.chat.db.pool");

let db: ChatDb | null = null;

export function getChatDb(): ChatDb {
  if (!db) {
    db = drizzle(getProcessPool(POOL_KEY, () => requireEnv("DATABASE_URL")), { schema });
  }
  return db;
}

/** Close the pool (graceful shutdown / tests). */
export async function closeChatDb(): Promise<void> {
  db = null;
  await closeProcessPool(POOL_KEY);
}
