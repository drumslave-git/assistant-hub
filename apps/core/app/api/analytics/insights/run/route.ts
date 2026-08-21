import {
  getAnalyticsJobInfo,
  runAnalyticsInsightsNow,
} from "@/features/analytics/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * Analytics insight job API. `GET` reports the job info the dashboard card renders
 * (ticker status, next/last run, day backlog); `POST` triggers one run immediately
 * (dashboard "Run now") and reports it again. A run with no LLM configured, or
 * nothing to compute, settles as a harmless no-op.
 */
export const GET = defineRoute(async () => ok(await getAnalyticsJobInfo()));

export const POST = defineRoute(async () => {
  await runAnalyticsInsightsNow();
  return ok(await getAnalyticsJobInfo());
});
