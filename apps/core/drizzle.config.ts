import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

// THE database (the core store, `store/`) — one schema, one migration chain
// since the Phase 10 cutover. drizzle-kit runs outside the Next.js runtime,
// so load .env* the same way Next does; `db:generate` needs no database,
// `db:migrate` reads DATABASE_URL.
loadEnvConfig(process.cwd());

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
