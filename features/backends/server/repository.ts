import "server-only";

import { asc, eq, ne, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { backends, type BackendRow } from "@/db/schema";
import { type LlmBackendId, toLlmBackendId } from "@/lib/llm-backend";

/**
 * Typed persistence for the backends catalog. Pure data access: no policy, no
 * validation, no trace recording (the service owns those). Every function takes
 * a {@link DrizzleDb} so it runs against the pool or a test instance.
 *
 * Records include the raw API key — callers must never return it to clients.
 */

/** A backend as stored, including the secret API key. */
export interface BackendRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  /** Which inference server answers at `baseUrl` — see `@/lib/llm-backend`. */
  type: LlmBackendId;
  createdAt: string;
  updatedAt: string;
}

/** Columns a create sets. */
export interface BackendValues {
  name: string;
  baseUrl: string;
  apiKey: string | null;
  type: LlmBackendId;
}

/**
 * Handling one message resolves backend rows several times (chat runtime, role
 * runtimes, policy…), and every scheduler tick re-reads them. The catalog only
 * changes through the CRUD below, so the same short-lived cache the settings
 * repository uses collapses those reads to one query per window. Keyed per db
 * handle so test databases never share entries with the app pool. Disabled
 * under Vitest: integration tests truncate tables underneath the repository.
 */
const BACKENDS_CACHE_TTL_MS = process.env.VITEST ? 0 : 3_000;

interface CacheEntry {
  records: BackendRecord[];
  expiresAt: number;
}

const cache = new WeakMap<DrizzleDb, CacheEntry>();

function invalidate(db: DrizzleDb): void {
  cache.delete(db);
}

function mapRow(row: BackendRow): BackendRecord {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    // Coerced, not cast: the column is plain text, so a hand-edited or
    // future-version value must degrade to the conservative adapter rather than
    // reach the adapter registry as an id it does not have.
    type: toLlmBackendId(row.type),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All backends, oldest first (stable creation order). Cached briefly. */
export async function listBackends(db: DrizzleDb): Promise<BackendRecord[]> {
  const cached = cache.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.records;
  const rows = await db.query.backends.findMany({ orderBy: [asc(backends.createdAt)] });
  const records = rows.map(mapRow);
  cache.set(db, { records, expiresAt: Date.now() + BACKENDS_CACHE_TTL_MS });
  return records;
}

/** One backend by id, or null. Served from the same cached listing. */
export async function getBackendById(db: DrizzleDb, id: string): Promise<BackendRecord | null> {
  return (await listBackends(db)).find((b) => b.id === id) ?? null;
}

/**
 * Whether a name is already taken (case-insensitive), optionally excluding one
 * id (for renames). Names are unique per operator convenience, not by DB
 * constraint, so this check is the source of truth.
 */
export async function isNameTaken(db: DrizzleDb, name: string, exceptId?: string): Promise<boolean> {
  const lowerMatch = sql`lower(${backends.name}) = lower(${name})`;
  const where = exceptId ? sql`${lowerMatch} and ${ne(backends.id, exceptId)}` : lowerMatch;
  const rows = await db.select({ id: backends.id }).from(backends).where(where).limit(1);
  return rows.length > 0;
}

/** Insert a backend with an app-generated id. Returns the stored record. */
export async function insertBackend(
  db: DrizzleDb,
  id: string,
  values: BackendValues,
): Promise<BackendRecord> {
  const now = new Date();
  const [row] = await db
    .insert(backends)
    .values({ id, ...values, createdAt: now, updatedAt: now })
    .returning();
  invalidate(db);
  return mapRow(row);
}

/** Apply a patch to one backend. Returns the updated record, or null if unknown. */
export async function updateBackend(
  db: DrizzleDb,
  id: string,
  patch: Partial<BackendValues>,
): Promise<BackendRecord | null> {
  const [row] = await db
    .update(backends)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(backends.id, id))
    .returning();
  invalidate(db);
  return row ? mapRow(row) : null;
}

/** Delete one backend. Returns true if a row was removed. */
export async function deleteBackend(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(backends).where(eq(backends.id, id)).returning({ id: backends.id });
  invalidate(db);
  return rows.length > 0;
}
