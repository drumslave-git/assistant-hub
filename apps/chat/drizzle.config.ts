import "dotenv/config";

import { defineConfig } from "drizzle-kit";

// The chat store — this app's OWN database (PLAN.md: each app owns its own
// storage). `db:generate` needs no database; `db:migrate` reads DATABASE_URL
// from this app's environment (`apps/chat/.env` in dev).
export default defineConfig({
  dialect: "postgresql",
  schema: "./store/schema.ts",
  out: "./store/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
