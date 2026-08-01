import "server-only";

import { FEATURES } from "@/lib/features";
import { createDailyScheduler, type DailyJobInfoBase } from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withTrace } from "@/server/trace";

import {
  getYtDlpInstallation,
  updateYtDlp,
  type YtDlpSource,
  type YtDlpUpdateResult,
} from "./ytdlp-binary";

/**
 * Daily scheduler for the yt-dlp update job — the shared daily-job model
 * (`server/jobs/daily-scheduler.ts`), so it gets the same run time, "Run now",
 * status card, and live updates as every other background job.
 *
 * Nightly rather than on-demand: the failure this prevents is a *silent* one. A
 * stale yt-dlp does not warn anybody, it just answers every media page with an
 * extraction error, and finding that out from a user's failed request is the
 * outcome the job exists to avoid.
 *
 * No advisory lock, unlike the LLM jobs. Those coordinate across processes
 * sharing one database; this one writes a file inside its own container, so a
 * second instance would have a separate `data/bin` to update and nothing to
 * contend over. Re-entry within a process is already excluded by the interval
 * scheduler's overlap guard.
 */

/** One update check, traced like every other meaningful action. */
async function runUpdate(ctx?: IntervalRunContext): Promise<string> {
  return withTrace(
    {
      feature: FEATURES["ytdlp-updater"].id,
      action: "update",
      trigger: { kind: "cron", actor: "ytdlp-updater" },
      inputSummary: `${process.platform}/${process.arch}`,
    },
    async (trace) => {
      let result: YtDlpUpdateResult;
      try {
        result = await updateYtDlp({
          onStep: (step) => ctx?.reportProgress({ step }),
        });
      } finally {
        ctx?.reportProgress(null);
      }

      await trace.event({
        message: result.summary,
        type: result.updated ? "output" : "step",
        level: result.updated ? "success" : "info",
        data: {
          previousVersion: result.previousVersion,
          latestVersion: result.latestVersion,
          updated: result.updated,
        },
      });
      await trace.succeed({ outputSummary: result.summary });
      return result.summary;
    },
  );
}

const scheduler = createDailyScheduler({
  name: "ytdlp-updater",
  feature: FEATURES["ytdlp-updater"],
  runJob: runUpdate,
});

/**
 * Start the daily poller (boot), and check once immediately when no managed copy
 * exists yet.
 *
 * That boot check is the other half of the operator decision not to persist
 * `data/bin` (2026-08-01): a recreated container starts on the build the image
 * pinned, which may be months old by then, and waiting until the night's run
 * would leave a whole day of media downloads on it. Best-effort — a failure here
 * must never gate startup, and the nightly run retries anyway.
 */
export function startYtDlpUpdater(): void {
  scheduler.start();
  void (async () => {
    const installation = await getYtDlpInstallation().catch(() => null);
    if (installation?.source === "managed") return;
    await scheduler.runNow().catch(() => undefined);
  })();
}

/** Stop the poller (shutdown). */
export function stopYtDlpUpdater(): void {
  scheduler.stop();
}

/** Force an update check as soon as possible (dashboard "Run now"). */
export function runYtDlpUpdateNow(): Promise<void> {
  return scheduler.runNow();
}

/** Job info for the dashboard card: the shared base plus which yt-dlp is in use. */
export interface YtDlpJobInfo extends DailyJobInfoBase {
  /** Version the media downloader will run right now, or null when none is installed. */
  installedVersion: string | null;
  /** Where that binary comes from — the self-updating copy, `PATH`, or nowhere. */
  source: YtDlpSource;
}

/** Current job info — reads settings for the next run and probes the binary in use. */
export async function getYtDlpJobInfo(): Promise<YtDlpJobInfo> {
  const [base, installation] = await Promise.all([
    scheduler.getBaseInfo(),
    getYtDlpInstallation(),
  ]);
  return { ...base, installedVersion: installation.version, source: installation.source };
}
