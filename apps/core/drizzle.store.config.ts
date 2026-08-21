import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

// The v2 core store (`store/`) — a separate database with its own migration
// chain, beside the v1 database this app still runs on. While v1 owns
// DATABASE_URL, the store reads STORE_DATABASE_URL; the name collapses to
// DATABASE_URL at cutover when the v1 chain is deleted.
loadEnvConfig(process.cwd());

export default defineConfig({
  dialect: "postgresql",
  schema: "./store/schema.ts",
  out: "./store/migrations",
  dbCredentials: {
    url: process.env.STORE_DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
