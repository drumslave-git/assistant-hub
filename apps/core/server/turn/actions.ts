import "server-only";

import { getProcessPool, closeProcessPool } from "@assistant-hub-swarm/db";
import type { Pool } from "pg";

import { requireEnv } from "@/server/env";

/**
 * The actions-started markers (core store `turn_actions` — see the schema
 * note and PLAN "Turn failure handling"): the first live use of the v2 core
 * store. A marker appears before a turn's first outward action and is
 * deleted when the turn settles terminally; the queue's retry decision reads
 * only its existence.
 */

const POOL_KEY = Symbol.for("assistant-hub.core.store.pool");

function storePool(): Pool {
  return getProcessPool(POOL_KEY, () => requireEnv("DATABASE_URL"));
}

export interface TurnActionMarkers {
  /** Record that the turn has acted. Idempotent; awaited BEFORE the action. */
  mark(correlationId: string): Promise<void>;
  has(correlationId: string): Promise<boolean>;
  /** Terminal settle (success or no-retry failure): the marker's job is done. */
  clear(correlationId: string): Promise<void>;
}

export function createTurnActionMarkers(pool: Pool = storePool()): TurnActionMarkers {
  return {
    async mark(correlationId: string): Promise<void> {
      await pool.query(
        `INSERT INTO turn_actions (correlation_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [correlationId],
      );
    },
    async has(correlationId: string): Promise<boolean> {
      const res = await pool.query(`SELECT 1 FROM turn_actions WHERE correlation_id = $1`, [
        correlationId,
      ]);
      return (res.rowCount ?? 0) > 0;
    },
    async clear(correlationId: string): Promise<void> {
      await pool.query(`DELETE FROM turn_actions WHERE correlation_id = $1`, [correlationId]);
    },
  };
}

/** Close the store pool (graceful shutdown). No-op if never created. */
export async function closeTurnActionStore(): Promise<void> {
  await closeProcessPool(POOL_KEY);
}
