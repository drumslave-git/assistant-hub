import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Testcontainers plumbing for store integration tests
 * (`@assistant-hub/db/testing` — test-only subpath, not the server-only
 * package root). One Postgres container (the production pgvector image), any
 * number of databases created inside it — the v1-split tests need a seeded
 * v1 database and a migrated store side by side.
 */

/** Same image as production (docker-compose): plain `postgres` has no pgvector. */
const POSTGRES_IMAGE = "pgvector/pgvector:pg17";

export interface TestPostgres {
  /** Create a database and return its connection URL. */
  createDatabase(name: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const adminUrl = container.getConnectionUri();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  return {
    async createDatabase(name: string): Promise<string> {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async stop(): Promise<void> {
      await admin.end();
      await container.stop();
    },
  };
}

/** Apply a drizzle migration chain to the database at `url`. */
export async function applyMigrations(url: string, migrationsFolder: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
