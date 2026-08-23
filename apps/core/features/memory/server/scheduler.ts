import "server-only";

import { getDb } from "@/db/drizzle";
import {
  getBackgroundRuntime,
  getEmbeddingRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import { currentSummaryDate } from "@/features/history/summary";
import { FEATURES } from "@/lib/features";
import { newRunCorrelationId } from "@/lib/trace";
import {
  createDailyScheduler,
  type DailyJobInfoBase,
} from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";
import { embed } from "@/server/llm/embeddings";

import { resolveSourceContent } from "@/server/source/tg-content";

import { runMemoryConsolidation, type ConsolidateDeps } from "./consolidate";
import { runMemoryExtraction, type ExtractDeps } from "./extract";
import { countDaysNeedingExtraction } from "./extraction-repository";
import { countPendingNotes } from "./service";

/**
 * Daily scheduler for memory — the shared daily-job model
 * (`server/jobs/daily-scheduler.ts`).
 *
 * The run is **two passes, in order**:
 *  1. *extraction* — read each finished chat-day out of the history mirror and
 *     queue the durable facts it revealed (`extract.ts`);
 *  2. *consolidation* — fold the whole pending queue into durable memory
 *     (`consolidate.ts`).
 *
 * Extraction runs first so a day's facts reach durable memory the **same** night
 * they are harvested, rather than sitting in the queue until the next one. The two
 * are one run, not two schedulers, because they are strictly sequential and share
 * the same lock: a consolidation racing the extraction that feeds it would just
 * leave half the night's notes for tomorrow.
 *
 * It all runs at night because it is expensive (an LLM pass per chat-day, per
 * person, and per general note) and nothing in *today's* conversation depends on
 * it: a fact said today is already carried into every reply verbatim by the
 * 24-hour history window. This is what makes the fact outlive that window.
 * Idempotent throughout: a consumed note is deleted and an unchanged day is
 * skipped, so a re-run costs nothing.
 */

/**
 * Resolve the real collaborators for both passes. Embeddings are optional: with no
 * embedding model configured the notes are still extracted, consolidated, and
 * injected into replies, they just are not semantically searchable — degraded, not
 * failed.
 */
async function resolveDeps(): Promise<(ConsolidateDeps & ExtractDeps) | null> {
  const [llm, embedding, timeZone] = await Promise.all([
    getBackgroundRuntime().catch(() => null),
    getEmbeddingRuntime().catch(() => null),
    getTimezone().catch(() => "UTC"),
  ]);
  if (!llm) return null;
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey, backend: llm.backend };
  return {
    complete: (messages, trace) =>
      chatCompletion(conn, {
        model: llm.model,
        messages,
        priority: "background",
        ...(trace ? { trace } : {}),
      }),
    embed: embedding ? (texts) => embed(embedding, texts) : null,
    timeZone,
  };
}

/**
 * One night's memory run — extraction then consolidation — with the real
 * collaborators, under a single advisory lock held across both passes.
 *
 * Extraction failing does not skip consolidation: the queue may already hold notes
 * from the `memory_save` tool, and a dead extraction pass is no reason to leave
 * them pending another day. Its failure is recorded on its own trace and reported
 * in the summary.
 */
async function runJob(ctx?: IntervalRunContext): Promise<string> {
  const deps = await resolveDeps();
  if (!deps) return "LLM not configured";
  // Extraction reads the mirror from the owning source; without its API the
  // consolidation half still runs (tool-saved notes are local).
  const extractable = resolveSourceContent() != null;

  // One correlation for the whole night: every extraction chat-day trace and
  // the consolidation trace carry it, so the run reads start to end in Debug.
  const runCorrelationId = newRunCorrelationId("memory");
  const outcome = await withAdvisoryLock("memory", async () => {
    let extracted: string;
    try {
      const extraction = extractable
        ? await runMemoryExtraction({
            ...deps,
            runCorrelationId,
            onProgress: ctx?.reportProgress,
          })
        : { summary: "skipped (telegram service not configured)" };
      extracted = extraction.summary;
    } catch (err) {
      extracted = `extraction failed (${err instanceof Error ? err.message : String(err)})`;
    }
    const consolidation = await runMemoryConsolidation({
      ...deps,
      runCorrelationId,
      onProgress: ctx?.reportProgress,
    });
    return { summary: `${extracted}; ${consolidation.summary}` };
  });
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

const scheduler = createDailyScheduler({
  name: "memory",
  feature: FEATURES.memory,
  runJob,
});

/** Start the daily poller (boot). Idempotent. */
export function startMemoryScheduler(): void {
  scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopMemoryScheduler(): void {
  scheduler.stop();
}

/**
 * Force tonight's memory run (extraction + consolidation) as soon as possible
 * (dashboard "Run now").
 */
export function runMemoryConsolidationNow(): Promise<void> {
  return scheduler.runNow();
}

/** Job info for the dashboard card. */
export interface MemoryJobInfo extends DailyJobInfoBase {
  /** Notes still waiting to be folded in — the visible backlog. */
  pendingNotes: number;
  /** Chat-days passive extraction has not read yet — the other half of the backlog. */
  pendingExtractionDays: number;
  /** Whether an embedding model is configured (i.e. memory search is semantic). */
  embeddingsConfigured: boolean;
}

/** Current job info — reads settings and counts the outstanding backlog. */
export async function getMemoryJobInfo(): Promise<MemoryJobInfo> {
  const [base, embedding] = await Promise.all([
    scheduler.getBaseInfo(),
    getEmbeddingRuntime().catch(() => null),
  ]);
  const content = resolveSourceContent();
  const [pendingNotes, pendingExtractionDays] = await Promise.all([
    countPendingNotes(getDb()).catch(() => 0),
    content
      ? countDaysNeedingExtraction(content, getDb(), {
          timeZone: base.timezone,
          today: currentSummaryDate(new Date(), base.timezone),
        }).catch(() => 0)
      : Promise.resolve(0),
  ]);

  return {
    ...base,
    pendingNotes,
    pendingExtractionDays,
    embeddingsConfigured: embedding != null,
  };
}
