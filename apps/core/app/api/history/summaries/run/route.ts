import {
  getSummaryJobInfo,
  runSummarizationNow,
} from "@/features/history/server/summary-scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * "Run now" for the daily summarization job. Fire-and-forget — a backlog can take
 * many LLM passes, so the response returns the job snapshot immediately and
 * progress arrives live over the `history` SSE topic.
 */
export const POST = defineRoute(async () => {
  void runSummarizationNow();
  return ok(await getSummaryJobInfo());
});
