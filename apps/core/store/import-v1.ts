import { loadEnvConfig } from "@next/env";

import { runCoreImport } from "./import/run";

// CLI entry for the one-shot v1 → core-store import (`npm run import:v1`).
// Reads V1_DATABASE_URL (a COPY of the v1 database during rehearsal — never
// production) and STORE_DATABASE_URL (the freshly-migrated core store).
loadEnvConfig(process.cwd());

const v1Url = process.env.V1_DATABASE_URL;
const targetUrl = process.env.STORE_DATABASE_URL;
if (!v1Url || !targetUrl) {
  console.error(
    "Set V1_DATABASE_URL (v1 copy) and STORE_DATABASE_URL (migrated core store) — see .env.example.",
  );
  process.exit(2);
}

try {
  const report = await runCoreImport({
    v1Url,
    targetUrl,
    log: (line) => console.log(`[import:core] ${line}`),
  });
  console.log(report.render());
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error("[import:core] failed:", error);
  process.exit(1);
}
