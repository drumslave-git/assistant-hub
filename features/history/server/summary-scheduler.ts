import "server-only";

import { getDb } from "@/db/drizzle";
import {
  getBackgroundRuntime,
  getEmbeddingRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import {
  createDailyScheduler,
  type DailyJobInfoBase,
} from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";
import { embed } from "@/server/llm/embeddings";

import { currentSummaryDate } from "../summary";
import { countDaysNeedingSummary } from "./summaries-repository";
import { runSummarization, type SummarizeDeps } from "./summarize";

/**
 * Daily scheduler for history summarization — the shared daily-job model
 * (`server/jobs/daily-scheduler.ts`): when the configured local run time
 * passes, the outstanding days are summarized under a cross-process advisory
 * lock.
 *
 * It runs at night because it is the expensive job (one or more LLM passes per
 * chat-day) and nothing depends on it being fresh: the last 24 hours are already
 * injected into every reply verbatim, so a day only needs summarizing once it is
 * over. Idempotent — the due-scan skips days already summarized at their current
 * message count — so a restart re-triggering the day's run costs nothing.
 */

/**
 * Resolve the real collaborators. Embeddings are optional: with no embedding model
 * configured the day is still summarized and stored, just without semantic search
 * — a degraded capability, not a failed job.
 */
async function resolveDeps(): Promise<SummarizeDeps | null> {
  const [llm, embedding, timeZone] = await Promise.all([
    getBackgroundRuntime().catch(() => null),
    getEmbeddingRuntime().catch(() => null),
    getTimezone().catch(() => "UTC"),
  ]);
  if (!llm) return null;
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey, backend: llm.backend };
  return {
    complete: (messages) =>
      chatCompletion(conn, { model: llm.model, messages, priority: "background" }),
    embed: embedding ? (texts) => embed(embedding, texts) : null,
    timeZone,
  };
}

/** One summarization run with the real collaborators, under the advisory lock. */
async function runJob(ctx?: IntervalRunContext): Promise<string> {
  const deps = await resolveDeps();
  if (!deps) return "LLM not configured";

  const outcome = await withAdvisoryLock("history-summaries", () =>
    runSummarization({ ...deps, onProgress: ctx?.reportProgress }),
  );
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

const scheduler = createDailyScheduler({
  name: "history-summaries",
  feature: FEATURES["history-summaries"],
  runJob,
});

/** Start the daily poller (boot). Idempotent. */
export function startSummaryScheduler(): void {
  scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopSummaryScheduler(): void {
  scheduler.stop();
}

/** Force a summarization run as soon as possible (dashboard "Run now"). */
export function runSummarizationNow(): Promise<void> {
  return scheduler.runNow();
}

/** Job info for the dashboard card. */
export interface SummaryJobInfo extends DailyJobInfoBase {
  /** Chat-days still awaiting a summary — the visible backlog. */
  pendingDays: number;
  /** Whether an embedding model is configured (i.e. semantic search is on). */
  embeddingsConfigured: boolean;
}

/** Current job info — reads settings and counts the outstanding backlog. */
export async function getSummaryJobInfo(): Promise<SummaryJobInfo> {
  const [base, embedding] = await Promise.all([
    scheduler.getBaseInfo(),
    getEmbeddingRuntime().catch(() => null),
  ]);
  const pendingDays = await countDaysNeedingSummary(getDb(), {
    timeZone: base.timezone,
    today: currentSummaryDate(new Date(), base.timezone),
  }).catch(() => 0);

  return { ...base, pendingDays, embeddingsConfigured: embedding != null };
}
