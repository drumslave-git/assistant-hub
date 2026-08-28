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
  startMessageIndexing,
  stopMessageIndexing,
} from "@/features/history/server/index-scheduler";
import {
  startSummaryScheduler,
  stopSummaryScheduler,
} from "@/features/history/server/summary-scheduler";
import { startMemoryScheduler, stopMemoryScheduler } from "@/features/memory/server/scheduler";
import { startTaskScheduler, stopTaskScheduler } from "@/features/tasks/server/scheduler";
import { reconcileManagedConnections } from "@/features/tool-connections/server/managed";
import {
  startSelfImprovementScheduler,
  stopSelfImprovementScheduler,
} from "@/features/self-improvement/server/scheduler";
import { startVisionBackfill, stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import {
  startSourceEventsConsumerFromEnv,
  type SourceEventsConsumer,
} from "@/server/source/events-consumer";
import { startTraceStore, stopTraceStore } from "@/server/trace";
import { startTurnConsumerFromEnv, type TurnConsumer } from "@/server/turn/consume";

/**
 * Node-runtime bootstrap, split out of `instrumentation.ts` so the Node-only
 * `process` APIs (signal handlers, exit) never appear in the Edge-analyzed
 * instrumentation module. Imported dynamically only when the server runs in
 * the Node.js runtime.
 *
 * Since the source split the core runs NO Telegram poller: inbound turns
 * arrive on the queue (the tg app enqueues), replies leave as bus events,
 * and everything Telegram-shaped is the tg service's. What boots here is
 * the brain — the queue consumer, the bus subscriber, and the background
 * jobs.
 */
export function registerNode(): void {
  let shuttingDown = false;
  let turnConsumer: TurnConsumer | null = null;
  let eventsConsumer: SourceEventsConsumer | null = null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await turnConsumer?.close().catch(() => undefined);
    await eventsConsumer?.close().catch(() => undefined);
    stopVisionBackfill();
    stopMessageIndexing();
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
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // Arm the file-backed trace store: warm the current month from disk and start
  // the periodic flush that appends settled traces to their monthly log file.
  // Best-effort — a failure here must never gate server startup.
  void startTraceStore().catch(() => undefined);

  // Start the inbound-turn queue consumer — the pipeline's ONLY entrance
  // since the source split. Env-gated (REDIS_URL + STORE_DATABASE_URL), and
  // loudly so: a core without its queue processes no messages at all.
  void startTurnConsumerFromEnv()
    .then((consumer) => {
      turnConsumer = consumer;
      if (consumer) {
        console.log("Inbound turn consumer started (queue: inbound-messages)");
      } else {
        console.warn(
          "Inbound turn consumer NOT started — set REDIS_URL and STORE_DATABASE_URL; " +
            "until then the core processes no incoming messages.",
        );
      }
    })
    .catch((err) => {
      console.error("Inbound turn consumer failed to start:", err);
    });

  // Start the cross-app event subscriber (feedback.recorded → the learning
  // steps; the SSE bridge joins here when it lands). Same env gate.
  void startSourceEventsConsumerFromEnv()
    .then((consumer) => {
      eventsConsumer = consumer;
      if (consumer) console.log("Source events consumer started (channel: assistant-hub:events)");
    })
    .catch((err) => {
      console.error("Source events consumer failed to start:", err);
    });

  // Bring the source apps' own MCP servers in line with configuration and
  // take their current toolsets. Their tools ship with the release, so the
  // snapshot follows the code rather than waiting for an operator to apply it
  // (see `managed.ts`). A source that is still starting keeps the tools it
  // last offered, and the trace says which app did not answer.
  void reconcileManagedConnections().catch((err) => {
    console.error("Source tool connections could not be reconciled:", err);
  });

  // Start the in-process vision-backfill scheduler. It arms an initial run so any
  // media left `pending` from before boot is captioned during the first quiet
  // window; bot activity re-arms the idle wait thereafter. A run with no LLM
  // configured settles as a no-op.
  startVisionBackfill();

  // Start the in-process message search-indexing scheduler. It builds each
  // message's searchable text (its own words plus what its photo/video/voice
  // says) and embeds it, so `history_search` finds things by meaning. Runs on a
  // longer idle debounce than the backfill above, since it wants that run's
  // descriptions; with no embedding model configured it still indexes the text.
  startMessageIndexing();

  // Start the periodic tasks poller. It fires due tasks at their
  // wall-clock time (independent of bot activity); a tick with no LLM configured,
  // no due tasks, or the source unreachable settles as a harmless no-op.
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
}
