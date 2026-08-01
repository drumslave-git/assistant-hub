import "server-only";

import {
  startAnalyticsScheduler,
  stopAnalyticsScheduler,
} from "@/features/analytics/server/scheduler";
import {
  startBrowserAgentRunner,
  stopBrowserAgentRunner,
} from "@/features/browser-agent/server/runner";
import {
  startYtDlpUpdater,
  stopYtDlpUpdater,
} from "@/features/browser-agent/server/ytdlp-scheduler";
import {
  startSummaryScheduler,
  stopSummaryScheduler,
} from "@/features/history/server/summary-scheduler";
import { startMemoryScheduler, stopMemoryScheduler } from "@/features/memory/server/scheduler";
import { startTaskScheduler, stopTaskScheduler } from "@/features/scheduled-tasks/server/scheduler";
import {
  startSelfImprovementScheduler,
  stopSelfImprovementScheduler,
} from "@/features/self-improvement/server/scheduler";
import { startVisionBackfill, stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { startTraceStore, stopTraceStore } from "@/server/trace";

import { startBot, stopBot } from "./bot-manager";

/**
 * Node-runtime bot bootstrap, split out of `instrumentation.ts` so the Node-only
 * `process` APIs (signal handlers, exit) never appear in the Edge-analyzed
 * instrumentation module. Imported dynamically only when the server runs in the
 * Node.js runtime.
 */
export function registerNode(): void {
  // Release the single getUpdates lock promptly on shutdown so a restart/redeploy
  // doesn't collide with the previous poller.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopVisionBackfill();
    stopTaskScheduler();
    stopSelfImprovementScheduler();
    stopSummaryScheduler();
    stopMemoryScheduler();
    stopAnalyticsScheduler();
    stopBrowserAgentRunner();
    stopYtDlpUpdater();
    // Flush any settled traces still buffered in memory before the process exits,
    // so a graceful restart doesn't lose the last window of debug history.
    await stopTraceStore().catch(() => undefined);
    await Promise.race([
      stopBot().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // Arm the file-backed trace store: warm the current month from disk and start
  // the periodic flush that appends settled traces to their monthly log file.
  // Best-effort — a failure here must never gate server startup.
  void startTraceStore().catch(() => undefined);

  // Start the in-process vision-backfill scheduler. It arms an initial run so any
  // media left `pending` from before boot is captioned during the first quiet
  // window; bot activity re-arms the idle wait thereafter. Independent of the bot
  // token — a run with no LLM configured settles as a no-op.
  startVisionBackfill();

  // Start the periodic scheduled-tasks poller. It fires due tasks at their
  // wall-clock time (independent of bot activity); a tick with no LLM configured,
  // no due tasks, or the bot stopped settles as a harmless no-op.
  startTaskScheduler();

  // Start the daily self-improvement poller. It checks once a minute whether the
  // configured local run time has been reached and incorporates the feedback
  // backlog; a tick with nothing due or no LLM configured is a harmless no-op.
  startSelfImprovementScheduler();

  // Start the daily history-summarization poller. At its configured local run
  // time it compresses each finished chat-day into searchable topic summaries
  // (including any days imported or edited since the last run); nothing due, or no
  // LLM configured, settles as a no-op.
  startSummaryScheduler();

  // Start the daily memory-consolidation poller. At its configured local run time
  // it folds the notes the bot saved during the day into durable memory (one merge
  // per person, one reconcile per general fact). Notes are already readable before
  // this runs — replies fold the pending queue in — so nothing due, or no LLM
  // configured, settles as a harmless no-op.
  startMemoryScheduler();

  // Start the daily analytics-insight poller. At its configured local run time it
  // scores each finished chat-day's mood + top topic and rolls up the touched
  // month/year/all-time periods (word of the period, top topic). The numeric
  // charts don't wait for it; nothing due, or no LLM configured, is a no-op.
  startAnalyticsScheduler();

  // Start the browser-agent runner: sweep any run left `running` by a previous
  // process (a crash/redeploy mid-run) to `failed`, then drain the queued runs.
  // New runs are picked up immediately via the enqueue signal; a run with no LLM
  // configured settles as a failure rather than hanging.
  startBrowserAgentRunner();

  // Start the daily yt-dlp update check, plus one immediate check when this
  // container has no self-updated copy yet. yt-dlp tracks sites that change on
  // purpose, so the build baked into the image goes stale on its own schedule;
  // without this, every media download starts failing at once and nothing says
  // why. A machine with no yt-dlp and no upstream build for its platform settles
  // as a harmless no-op.
  startYtDlpUpdater();

  // Fire-and-forget: do not block server startup on the Telegram handshake. A
  // network failure here is not fatal — the manager reconnects on its own — so
  // the warning below is the boot-time note, not the last word.
  void startBot()
    .then((status) => {
      if (status.state === "running") {
        console.log(`Telegram bot @${status.username} started (long polling)`);
      } else {
        console.warn(
          `Telegram bot not autostarted: ${status.error ?? "no bot token configured — set one in Settings and Start it"}`,
        );
      }
    })
    .catch((err: unknown) => {
      console.error(
        "Telegram bot autostart failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
}
