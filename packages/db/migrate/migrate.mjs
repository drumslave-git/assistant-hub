// Production migration runner (container entrypoint step).
//
// Applies pending Drizzle migrations using drizzle's own programmatic migrator
// (`drizzle-orm/node-postgres/migrator`) — the documented method for slim,
// bundled deployments where the drizzle-kit CLI is intentionally absent. Reads
// DATABASE_URL from the environment and the SQL files copied next to this file.
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("[migrate] DATABASE_URL not set; skipping migrations");
  process.exit(0);
}

const migrationsFolder = fileURLToPath(new URL("./db/migrations", import.meta.url));
const pool = new pg.Pool({ connectionString });

try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log("[migrate] migrations applied");
} finally {
  await pool.end();
}
