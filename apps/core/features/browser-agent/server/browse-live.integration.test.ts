import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/drizzle";
import { closePool } from "@/db/pool";
import { getLlmRuntime } from "@/features/settings/server/service";
import { closeSharedChromium } from "@/features/link-fetch/server/playwright";

import type { BrowserDownloadRecord } from "../types";
import { runBrowserAgent } from "./agent";
import { enqueueBrowserRun, getBrowserAgentRunView } from "./service";
import { startBrowserAgentRunner } from "./runner";
import { emitRunEnqueued } from "./signal";
import { BrowserAgentSession } from "./session";
import type { AgentToolContext } from "./tools";

/**
 * Opt-in **real** browse: the configured LLM drives a **real** headless Chromium
 * over a live public page, with no Telegram anywhere (this is exactly the
 * dashboard-run path — a run with no chat). Skipped unless `LLM_LIVE=1`.
 *
 * Unlike the tool-selection suite, the browser tools here really execute. It
 * proves the whole loop end to end: the model navigates, reads the snapshot,
 * (optionally) screenshots, and writes a report grounded in what the page
 * actually said. example.com is used because its content is fixed and public.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- browser-agent/server/browse-live`
 */
const LLM_LIVE = process.env.LLM_LIVE === "1";
const BROWSE_TIMEOUT = 180_000;

describe.skipIf(!LLM_LIVE)("browser agent — real browse (live)", () => {
  beforeAll(() => {
    loadEnvConfig(process.cwd());
  });
  afterAll(async () => {
    await closeSharedChromium().catch(() => {});
    await closePool().catch(() => {});
  });

  it(
    "navigates a real page and reports what it actually says",
    async () => {
      const runtime = await getLlmRuntime();
      if (!runtime) throw new Error("LLM is not configured in DB settings.");

      const session = new BrowserAgentSession();
      const downloads: BrowserDownloadRecord[] = [];
      const actions: string[] = [];
      const screenshots: { seq: number }[] = [];

      const toolContext: AgentToolContext = {
        session,
        isOwner: true,
        allowedDownloadUrls: null,
        downloadMaxMb: 50,
        downloadLimitBytes: 10 * 1024 ** 3,
        downloads,
        onAction: (action) => {
          actions.push(action);
        },
        onStep: () => {},
        onScreenshot: async () => {
          const seq = screenshots.length;
          screenshots.push({ seq });
          return seq;
        },
        onDownload: async () => "kept" as const,
      };

      try {
        const result = await runBrowserAgent({
          goal:
            "Open https://example.com and tell me the exact main heading and what the page says the domain is for.",
          conn: { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey },
          model: runtime.model,
          toolContext,
          requiredLanguage: null,
        });

        // The agent must have actually driven the browser (at least a navigate).
        expect(actions.some((a) => a.startsWith("navigate"))).toBe(true);
        // The report must be grounded in the real page, not invented: example.com's
        // fixed copy says the domain is for use in illustrative examples.
        expect(result.report.length).toBeGreaterThan(0);
        expect(result.report.toLowerCase()).toMatch(/example|illustrative|documents/);

        console.info(
          `\n[live browse] actions=${actions.length} screenshots=${screenshots.length}\nreport: ${result.report}\n`,
        );
      } finally {
        await session.close();
      }
    },
    BROWSE_TIMEOUT,
  );

  it(
    "records a live activity feed through the real runner (dashboard run)",
    async () => {
      const runtime = await getLlmRuntime();
      if (!runtime) throw new Error("LLM is not configured in DB settings.");
      const db = getDb();

      // A dashboard run has no chat — nothing is sent to Telegram; the report and
      // the activity feed land on the run row, which is exactly what the UI reads.
      const run = await enqueueBrowserRun(
        { goal: "Open https://example.com and tell me its main heading.", chatId: null, isOwner: true },
        db,
      );
      startBrowserAgentRunner(db);
      emitRunEnqueued();

      // Poll the run detail the same way the dashboard does, until it settles.
      const started = Date.now();
      let detail = await getBrowserAgentRunView(run.id, db);
      while (detail && (detail.status === "queued" || detail.status === "running")) {
        if (Date.now() - started > BROWSE_TIMEOUT - 5000) break;
        await new Promise((r) => setTimeout(r, 1000));
        detail = await getBrowserAgentRunView(run.id, db);
      }

      expect(detail?.status).toBe("done");
      // The activity feed is populated and ordered: at least a navigate, ok.
      expect(detail!.activity.length).toBeGreaterThan(0);
      expect(detail!.activity[0].tool).toBe("browser_navigate");
      expect(detail!.activity.every((s) => typeof s.seq === "number")).toBe(true);
      expect(detail!.steps).toBe(detail!.activity.length);
      // A settled run drops its live state.
      expect(detail!.live).toBeNull();

      console.info(
        `\n[runner feed] status=${detail!.status} steps=${detail!.steps}\n` +
          detail!.activity.map((s) => `  ${s.seq}. ${s.tool} — ${s.ok ? "ok" : "FAIL"} — ${s.summary}`).join("\n") +
          `\n`,
      );
    },
    BROWSE_TIMEOUT,
  );
});
