import "server-only";

import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { getLlmRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { chatCompletion } from "@/server/llm/client";
import {
  createDailyScheduler,
  type DailyJobInfoBase,
} from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";

import { runSelfImprovement } from "./analyze";

/**
 * Daily scheduler for the self-improvement incorporation job — the shared
 * daily-job model (`server/jobs/daily-scheduler.ts`): when the configured local
 * run time passes, the feedback backlog is incorporated under a cross-process
 * advisory lock. The run is idempotent (an empty backlog is a no-op), so an
 * extra trigger after a restart is harmless.
 */

/** One incorporation run with the real collaborators, under the advisory lock. */
async function runIncorporation(ctx?: IntervalRunContext): Promise<string> {
  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return "LLM not configured";
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };

  const outcome = await withAdvisoryLock("self-improvement", async () => {
    const personalityPrompt = await getActivePersonalityPrompt().catch(() => null);
    return runSelfImprovement({
      complete: (messages) =>
        chatCompletion(conn, { model: runtime.model, messages, priority: "background" }),
      personalityPrompt,
      model: runtime.model,
      onProgress: ctx?.reportProgress,
    });
  });
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

const scheduler = createDailyScheduler({
  name: "self-improvement",
  feature: FEATURES["self-improvement"],
  runJob: runIncorporation,
});

/** Start the daily poller (boot). Idempotent. */
export function startSelfImprovementScheduler(): void {
  scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopSelfImprovementScheduler(): void {
  scheduler.stop();
}

/** Force an incorporation run as soon as possible (dashboard "Run now"). */
export function runSelfImprovementNow(): Promise<void> {
  return scheduler.runNow();
}

/** Job info for the dashboard card: the shared base and nothing more. */
export type SelfImprovementJobInfo = DailyJobInfoBase;

/** Current job info — reads settings for the next-run computation. */
export function getSelfImprovementJobInfo(): Promise<SelfImprovementJobInfo> {
  return scheduler.getBaseInfo();
}
