import { getMemoryJobInfo, runMemoryConsolidationNow } from "@/features/memory/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * "Run now" for the nightly memory-consolidation job. Fire-and-forget —
 * consolidation can take a while (an LLM pass per person and per general note), so
 * the response returns the job snapshot immediately and progress arrives live over
 * the `memory` SSE topic.
 */
export const POST = defineRoute(async () => {
  void runMemoryConsolidationNow();
  return ok(await getMemoryJobInfo());
});
