import "dotenv/config";

import { runTgImport } from "./import/run";

// CLI entry for the one-shot v1 → tg-store import (`npm run import:v1`).
// Reads V1_DATABASE_URL (a COPY of the v1 database during rehearsal — never
// production) and DATABASE_URL (the freshly-migrated tg store).
const v1Url = process.env.V1_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;
if (!v1Url || !targetUrl) {
  console.error(
    "Set V1_DATABASE_URL (v1 copy) and DATABASE_URL (migrated tg store) — see .env.example.",
  );
  process.exit(2);
}

try {
  const report = await runTgImport({
    v1Url,
    targetUrl,
    log: (line) => console.log(`[import:tg] ${line}`),
  });
  console.log(report.render());
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error("[import:tg] failed:", error);
  process.exit(1);
}
