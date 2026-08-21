import "server-only";

import { getProcessPool, closeProcessPool } from "@assistant-hub/db";
import type { Pool } from "pg";

import { requireEnv } from "@/server/env";

/**
 * The core store's Postgres pool: the shared process-wide singleton from
 * `@assistant-hub/db`, keyed for this app and fed by `DATABASE_URL`. The
 * Drizzle instance in `drizzle.ts` is built on top of this pool.
 */

const POOL_KEY = Symbol.for("llm-tg-bot.db.pool");

export function getPool(): Pool {
  return getProcessPool(POOL_KEY, () => requireEnv("DATABASE_URL"));
}

/** Close the pool (graceful shutdown / tests). No-op if never created. */
export async function closePool(): Promise<void> {
  return closeProcessPool(POOL_KEY);
}
