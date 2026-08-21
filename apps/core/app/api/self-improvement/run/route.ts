import {
  getSelfImprovementJobInfo,
  runSelfImprovementNow,
} from "@/features/self-improvement/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * "Run now" for the daily self-improvement job. Fire-and-forget — incorporation
 * can take a while (one LLM call per feedback), so the response returns the job
 * snapshot immediately and progress arrives live over the `feedback` SSE topic.
 */
export const POST = defineRoute(async () => {
  void runSelfImprovementNow();
  return ok(await getSelfImprovementJobInfo());
});
