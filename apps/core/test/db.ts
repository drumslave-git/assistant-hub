import { fileURLToPath } from "node:url";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import type { DrizzleDb } from "@/db/drizzle";
import * as schema from "@/db/schema";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../db/migrations", import.meta.url));

/**
 * Every table in the schema, derived rather than listed.
 *
 * This used to be a hand-written name list, which silently went stale the moment
 * a feature added a table: rows from one test leaked into the next, and the
 * failure surfaced as a baffling duplicate-key error in an unrelated assertion.
 * Reading the tables off the schema means a new table is isolated the day it
 * exists, with nothing to remember.
 */
const ALL_TABLES = Object.values(schema).flatMap((value) =>
  is(value, PgTable) ? [`"${getTableName(value)}"`] : [],
);

/**
 * Integration test database backed by a real Postgres (Testcontainers). Start
 * one per test file in `beforeAll`, `truncate()` between tests for isolation,
 * and `stop()` in `afterAll`.
 */
export interface TestDb {
  db: DrizzleDb;
  /**
   * The container's connection URI. Set `process.env.DATABASE_URL` to this
   * (before any `getDb()` call) to point the app's own pool at this container —
   * needed by flow tests that drive the real pipeline, which uses `getDb()`.
   */
  connectionUri: string;
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Same image as production (docker-compose). Plain `postgres` has no pgvector, so
 * the migration that enables the extension — and every embedding-backed test —
 * would fail against it.
 */
const POSTGRES_IMAGE = "pgvector/pgvector:pg17";

/**
 * Seed a minimal `chat_messages` mirror row. Media rows now require one (the
 * `message_media` → `chat_messages` FK: media never floats free of the mirror),
 * so any test inserting media directly must seed its message first — exactly
 * what the live pipeline does (mirror first, ingest second).
 */
export async function seedMirrorMessage(
  db: DrizzleDb,
  input: { chatId: string; telegramMessageId: number; processed?: boolean },
): Promise<void> {
  await db
    .insert(schema.chatMessages)
    .values({
      chatId: input.chatId,
      telegramMessageId: input.telegramMessageId,
      role: "user",
      userId: null,
      content: "",
      sentAt: new Date(),
      ...(input.processed != null ? { processed: input.processed } : {}),
    })
    .onConflictDoNothing({
      target: [schema.chatMessages.chatId, schema.chatMessages.telegramMessageId],
    });
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const connectionUri = container.getConnectionUri();
  const pool = new Pool({ connectionString: connectionUri });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    connectionUri,
    async truncate() {
      await pool.query(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`);
    },
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
