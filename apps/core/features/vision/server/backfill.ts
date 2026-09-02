import "server-only";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { withAdvisoryLock } from "@/server/jobs/lock";
import type { JobProgress } from "@/server/jobs/progress";
import type { SourceMediaBrowse } from "@/server/turn/source-media";
import { startTrace } from "@/server/trace";

import { describeAndStore, type DescribeDeps } from "./service";

/**
 * Vision backfill job — describe the media rows still `status='pending'` (bytes
 * intact) that were left un-captioned when they arrived (unaddressed / group
 * chatter). Each row is captioned by {@link describeAndStore}, which drops the
 * bytes on success, so a described row never comes back around.
 *
 * This is the job body behind the shared in-process idle scheduler
 * (`server/jobs/idle-scheduler.ts`); see `backfill-scheduler.ts` for the wiring.
 * Locking is a cross-process advisory lock; idempotency is the per-row
 * `pending` gating (a described/unavailable row is never re-fetched, and
 * `describeAndStore` re-checks status before spending an LLM call). Both together
 * mean a redeploy overlap can never double-describe a row.
 */

const FEATURE_ID = FEATURES["vision-backfill"].id;
const JOB_NAME = "vision-backfill";

/** How many pending rows to pull per DB fetch. */
const BATCH_SIZE = 10;
/** Safety cap on rows attempted in a single run, so one run can't spin forever. */
const MAX_ROWS_PER_RUN = 200;

/** Collaborators for the describe pass — the same shape the live path injects. */
export type VisionBackfillDeps = DescribeDeps;

/**
 * Where the pending rows live: the owning source's media over its internal
 * API (real), or a store-backed fake in tests. The describe pass writes back
 * through the same `store`, and the source drops the bytes.
 */
export type VisionBackfillSource = Pick<SourceMediaBrowse, "store" | "listPending" | "countPending">;

export interface VisionBackfillOptions {
  /** Cooperative stop signal from the scheduler; checked between rows. */
  isAborted?: () => boolean;
  /** What triggered the run (idle scheduler → system; a dashboard run → dashboard). */
  trigger?: TraceTrigger;
  /** Publish live per-row progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
}

export interface VisionBackfillResult {
  /** Rows captioned to text (bytes dropped). */
  described: number;
  /** Rows attempted but left pending (load/LLM failure or empty description). */
  unresolved: number;
  /** True when the run stopped early because live activity resumed. */
  interrupted: boolean;
  /** One-line human summary. */
  summary: string;
}

function summarize(described: number, unresolved: number, interrupted: boolean): string {
  if (described === 0 && unresolved === 0) return interrupted ? "interrupted, nothing done" : "nothing pending";
  const parts = [`${described} described`];
  if (unresolved > 0) parts.push(`${unresolved} unresolved`);
  if (interrupted) parts.push("interrupted");
  return parts.join(", ");
}

/**
 * Run one backfill pass. Never throws — any failure settles the trace and
 * returns a summary. Returns `unresolved`/`described` counts for the scheduler
 * status. When the advisory lock is already held elsewhere the run is skipped.
 */
export async function runVisionBackfill(
  deps: VisionBackfillDeps,
  source: VisionBackfillSource,
  options: VisionBackfillOptions = {},
  /** Where the advisory lock lives (the app's own DB; injectable in tests). */
  db: StoreDb = getStoreDb(),
): Promise<VisionBackfillResult> {
  const isAborted = options.isAborted ?? (() => false);
  const onProgress = options.onProgress ?? (() => {});
  const trigger: TraceTrigger = options.trigger ?? { kind: "system", actor: JOB_NAME };

  const trace = await startTrace(
    { feature: FEATURE_ID, action: "backfill", trigger, inputSummary: "describe pending media" }
  );

  try {
    const lock = await withAdvisoryLock(
      JOB_NAME,
      async (): Promise<VisionBackfillResult> => {
        const attempted = new Set<string>();
        let described = 0;
        let unresolved = 0;
        let interrupted = false;
        // The pending count when the run starts is this run's denominator; rows
        // leave `pending` as they are described, so it only shrinks from here.
        const total = await source.countPending();

        while (attempted.size < MAX_ROWS_PER_RUN) {
          if (isAborted()) {
            interrupted = true;
            break;
          }
          const batch = await source.listPending(BATCH_SIZE);
          const fresh = batch.filter((row) => !attempted.has(row.id));
          if (fresh.length === 0) break; // nothing new to do

          for (const row of fresh) {
            if (isAborted()) {
              interrupted = true;
              break;
            }
            attempted.add(row.id);
            onProgress({ step: "Describing media", current: attempted.size, total });
            const result = await describeAndStore(
              { chatId: row.chatId, sourceMessageId: row.sourceMessageId },
              deps,
              { store: source.store },
            );
            if (result && result.status === "described") described += 1;
            else unresolved += 1;
          }
        }

        await trace.event({
          type: "db",
          message: "backfill scan complete",
          data: { described, unresolved, interrupted, attempted: attempted.size },
        });
        return { described, unresolved, interrupted, summary: summarize(described, unresolved, interrupted) };
      },
      db,
    );

    if (!lock.ran) {
      const summary = "skipped — another run holds the lock";
      await trace.skip(summary);
      return { described: 0, unresolved: 0, interrupted: false, summary };
    }

    await trace.succeed({ outputSummary: lock.result.summary });
    return lock.result;
  } catch (err) {
    await trace.fail(err);
    const summary = err instanceof Error ? err.message : String(err);
    return { described: 0, unresolved: 0, interrupted: false, summary };
  }
}
