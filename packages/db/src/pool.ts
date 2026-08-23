import { Pool } from "pg";

/**
 * Process-global Postgres connection pool singletons, keyed by symbol.
 * Server-only.
 *
 * Held on `globalThis` like every other process-wide singleton (hub, trace
 * store, bot manager): a module-local would be re-created on each dev
 * hot-reload / bundle duplication, leaking connections. Each app keys its own
 * pool with a `Symbol.for` of its choosing and supplies its own connection
 * string (each app owns its own database — PLAN.md).
 */

type PoolGlobal = typeof globalThis & Record<symbol, Pool | undefined>;

/**
 * The pool registered under `key`, created on first use from
 * `connectionString`.
 */
export function getProcessPool(key: symbol, connectionString: () => string): Pool {
  const g = globalThis as PoolGlobal;
  if (!g[key]) {
    g[key] = new Pool({ connectionString: connectionString() });
  }
  return g[key];
}

/** Close the pool under `key` (graceful shutdown / tests). No-op if never created. */
export async function closeProcessPool(key: symbol): Promise<void> {
  const g = globalThis as PoolGlobal;
  const current = g[key];
  if (current) {
    delete g[key];
    await current.end();
  }
}
