import "server-only";

import { sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { searchEngineStats } from "@/db/schema";

import type { EngineStat } from "../types";

/**
 * The search sources' scoreboard: who actually returns results, and therefore in
 * what order the cascade should try them.
 *
 * Ranking is a smoothed success rate — `(successes + 1) / (attempts + 2)` — rather
 * than the raw ratio, for two reasons that matter on real data: an engine with no
 * history sits at 0.5 (tried in its configured position, not last, so it can prove
 * itself), and one lucky first hit does not out-rank a long record. Ties keep the
 * configured order, so the ranking only ever *reacts* to evidence.
 *
 * Counts are halved once an engine's attempts pass {@link DECAY_AT}, which keeps
 * the score reacting to the last ~100 searches instead of being anchored by
 * history: an engine that starts blocking sinks within a few searches, and one that
 * recovers climbs back rather than being condemned by its past.
 */

/** Attempts after which an engine's counters are halved (both, together). */
const DECAY_AT = 100;

/**
 * `column + increment`, halved when this attempt takes the row past {@link DECAY_AT}
 * total attempts. Both counters use it, so they decay together and the *rate* is
 * preserved while the weight of history is cut.
 */
function decayed(
  column: typeof searchEngineStats.successes | typeof searchEngineStats.failures,
  increment: number,
) {
  const total = sql`${searchEngineStats.successes} + ${searchEngineStats.failures} + 1`;
  return sql`case when ${total} > ${DECAY_AT} then (${column} + ${increment}) / 2 else ${column} + ${increment} end`;
}

/** Smoothed success rate in [0, 1]; an untried source scores 0.5. */
export function successRate(stat: { successes: number; failures: number }): number {
  return (stat.successes + 1) / (stat.successes + stat.failures + 2);
}

/**
 * Order `names` best-first by success rate, keeping the configured order for ties
 * and for sources with identical records. Pure — the caller supplies the stats.
 */
export function rankEngines(names: string[], stats: EngineStat[]): string[] {
  const byName = new Map(stats.map((stat) => [stat.engine, stat]));
  return names
    .map((name, index) => ({
      name,
      index,
      rate: successRate(byName.get(name) ?? { successes: 0, failures: 0 }),
    }))
    .sort((a, b) => b.rate - a.rate || a.index - b.index)
    .map((entry) => entry.name);
}

/** The whole scoreboard, best-first (the order the cascade will use). */
export async function listEngineStats(database?: DrizzleDb): Promise<EngineStat[]> {
  const db = database ?? getDb();
  const rows = await db.select().from(searchEngineStats);
  const stats = rows.map((row) => ({
    engine: row.engine,
    successes: row.successes,
    failures: row.failures,
    successRate: successRate(row),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastError: row.lastError,
  }));
  return stats.sort((a, b) => b.successRate - a.successRate || a.engine.localeCompare(b.engine));
}

/**
 * Record one attempt's outcome. Upserts so an engine appears the first time it is
 * tried, and never throws: a scoreboard write must not be able to fail a search
 * that already worked. `error` is kept only for a failure, as the operator's first
 * clue about why a source went quiet.
 */
export async function recordEngineOutcome(
  engine: string,
  ok: boolean,
  error?: string,
  database?: DrizzleDb,
): Promise<void> {
  const now = new Date();
  try {
    // Resolved inside the try, not as a default argument: with no DATABASE_URL,
    // `getDb()` throws, and a default argument would throw *past* this handler —
    // failing a search that had already succeeded.
    const db = database ?? getDb();
    await db
      .insert(searchEngineStats)
      .values({
        engine,
        successes: ok ? 1 : 0,
        failures: ok ? 0 : 1,
        lastSuccessAt: ok ? now : null,
        lastFailureAt: ok ? null : now,
        lastError: ok ? null : (error ?? null),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: searchEngineStats.engine,
        set: {
          // Count this attempt and, in the same statement, halve both counters once
          // the record passes the cap — so the increment and the decay can never
          // race two concurrent runs against each other.
          successes: decayed(searchEngineStats.successes, ok ? 1 : 0),
          failures: decayed(searchEngineStats.failures, ok ? 0 : 1),
          ...(ok
            ? { lastSuccessAt: now }
            : { lastFailureAt: now, lastError: error ?? null }),
          updatedAt: now,
        },
      });
  } catch (err) {
    // The search itself already succeeded or failed on its own terms; losing a
    // scoreboard write only costs ranking accuracy for one attempt.
    console.error(
      `browser-agent: failed to record the search outcome for ${engine}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
