import "server-only";

import type { Pool } from "pg";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";

/**
 * Postgres session-level advisory locks for background jobs — the DB-backed
 * locking half of the recorded background-job model. The in-process scheduler
 * already guarantees one run at a time within a process; the advisory lock
 * additionally guards *cross-process* overlap (e.g. two server instances briefly
 * co-existing during a redeploy) so a job never double-processes.
 *
 * Idempotency is a separate, job-owned concern (e.g. the vision backfill only
 * touches rows still `status='pending'`), so a lock miss is a benign skip, not a
 * failure.
 *
 * A session-level advisory lock lives on the connection that took it, so the
 * acquire, release, and hold must all be on one pinned connection. We pin a
 * dedicated pool client for the lock's lifetime; the job body (`fn`) is free to
 * use the shared pool for its own queries — the lock is global across the
 * database, not scoped to the connections that read/write rows.
 */

/**
 * Derive a stable 64-bit lock key from a job name. `hashtextextended` is a
 * built-in Postgres hash returning `bigint`, so distinct names get distinct
 * advisory-lock keys without a lookup table.
 */
async function lockKey(client: { query: Pool["query"] }, name: string): Promise<string> {
  const res = await client.query("select hashtextextended($1, 0)::text as key", [name]);
  return res.rows[0].key as string;
}

/**
 * Run `fn` while holding the named advisory lock. Returns `{ ran: false }`
 * without invoking `fn` when the lock is already held elsewhere; otherwise runs
 * `fn` and always releases the lock (even on throw).
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
  db: DrizzleDb = getDb(),
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  // drizzle-orm/node-postgres exposes the underlying pg Pool as `$client` at
  // runtime; it is just not in the DrizzleDb type surface.
  const pool = (db as unknown as { $client: Pool }).$client;
  const client = await pool.connect();
  try {
    const key = await lockKey(client, name);
    const acquired = await client.query("select pg_try_advisory_lock($1) as locked", [key]);
    if (!acquired.rows[0].locked) {
      return { ran: false };
    }
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [key]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
