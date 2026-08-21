import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { getPool } from "./pool";
import * as schema from "./schema";

/**
 * Drizzle database handle. Server-only. Repositories accept a {@link DrizzleDb}
 * so the same code runs against the shared pool in production and a
 * Testcontainers-backed instance in tests.
 */
export type DrizzleDb = NodePgDatabase<typeof schema>;

let db: DrizzleDb | null = null;

/** Lazily-created Drizzle instance bound to the shared connection pool. */
export function getDb(): DrizzleDb {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}
