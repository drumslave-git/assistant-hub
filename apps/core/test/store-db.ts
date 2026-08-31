import { fileURLToPath } from "node:url";

import { applyMigrations, startTestPostgres, type TestPostgres } from "@assistant-hub/db/testing";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import type { StoreDb } from "@/server/store/db";

import * as schema from "../store/schema";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../store/migrations", import.meta.url));

/**
 * Integration-test database for the CORE STORE chain (the one database after
 * the Phase 10 cutover) — the store-side sibling of the retiring v1
 * `test/db.ts`: one Testcontainers Postgres per suite, `truncate()` between
 * tests, `stop()` at the end. Tables are derived from the schema so a new
 * table is isolated the day it exists.
 */
export interface TestStoreDb {
  db: StoreDb;
  pool: Pool;
  /** The container's connection URI (point env-bound halves at it). */
  connectionUri: string;
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
}

const ALL_TABLES = Object.values(schema).flatMap((value) =>
  is(value, PgTable) ? [`"${getTableName(value)}"`] : [],
);

export async function startTestStoreDb(): Promise<TestStoreDb> {
  const pg: TestPostgres = await startTestPostgres();
  const connectionUri = await pg.createDatabase("store");
  await applyMigrations(connectionUri, MIGRATIONS_FOLDER);
  const pool = new Pool({ connectionString: connectionUri });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    connectionUri,
    async truncate() {
      await pool.query(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    },
    async stop() {
      await pool.end();
      await pg.stop();
    },
  };
}

/**
 * Seed a minimal `source_messages` mirror row (`source = 'tg'`). Media rows
 * reference the mirror by (chat, message), so any test inserting media
 * directly should seed its message first - exactly what the live pipeline
 * does (mirror first, ingest second).
 */
export async function seedSourceMessage(
  ctx: Pick<TestStoreDb, "pool">,
  input: { chatId: string; telegramMessageId: number; processed?: boolean; content?: string },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO source_messages
       (source, chat_id, source_message_id, dedupe_key, role, content, sent_at, processed)
     VALUES ('tg', $1, $2, $3, 'user', $4, now(), $5)
     ON CONFLICT DO NOTHING`,
    [
      input.chatId,
      String(input.telegramMessageId),
      `${input.chatId}:${input.telegramMessageId}`,
      input.content ?? "",
      input.processed ?? true,
    ],
  );
}
