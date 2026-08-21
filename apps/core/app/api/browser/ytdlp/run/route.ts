import {
  getYtDlpJobInfo,
  runYtDlpUpdateNow,
} from "@/features/browser-agent/server/ytdlp-scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * "Run now" for the daily yt-dlp update check. Fire-and-forget — a check that
 * finds an update downloads ~40 MB — so the response returns the job snapshot
 * immediately and the outcome arrives live over the `browser` SSE topic.
 */
export const POST = defineRoute(async () => {
  void runYtDlpUpdateNow();
  return ok(await getYtDlpJobInfo());
});
