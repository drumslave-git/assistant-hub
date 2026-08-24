import "server-only";

import { getSingleAssistantPersona } from "@/features/assistants/server/service";
import { getBackgroundRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { chatCompletion } from "@/server/llm/client";
import {
  createDailyScheduler,
  type DailyJobInfoBase,
} from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";

import { runSelfImprovement } from "./analyze";
import { resolveFeedbackPorts } from "./feedback-store";

/**
 * Daily scheduler for the self-improvement incorporation job — the shared
 * daily-job model (`server/jobs/daily-scheduler.ts`): when the configured local
 * run time passes, the feedback backlog is incorporated under a cross-process
 * advisory lock. The run is idempotent (an empty backlog is a no-op), so an
 * extra trigger after a restart is harmless.
 */

/** One incorporation run with the real collaborators, under the advisory lock. */
async function runIncorporation(ctx?: IntervalRunContext): Promise<string> {
  // The feedback rows live with the owning source; without its API there is
  // nothing to read or stamp — reported like an unconfigured LLM, never a
  // silent empty run.
  const ports = resolveFeedbackPorts();
  if (!ports) return "telegram service not configured (TG_API_URL / INTERNAL_API_TOKEN)";
  const runtime = await getBackgroundRuntime().catch(() => null);
  if (!runtime) return "LLM not configured";
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };

  const outcome = await withAdvisoryLock("self-improvement", async () => {
    // Transitional (see the assistants service): reflection has no event
    // naming an assistant, so only a single-assistant deployment composes
    // one as context.
    const personalityPrompt = await getSingleAssistantPersona().catch(() => null);
    return runSelfImprovement({
      complete: (messages, trace) =>
        chatCompletion(conn, {
          model: runtime.model,
          messages,
          priority: "background",
          ...(trace ? { trace } : {}),
        }),
      personalityPrompt,
      model: runtime.model,
      onProgress: ctx?.reportProgress,
      ports,
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
