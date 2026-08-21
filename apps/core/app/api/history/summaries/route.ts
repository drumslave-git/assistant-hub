import { getSummaryJobInfo } from "@/features/history/server/summary-scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * Status of the daily history-summarization job: next/last run, the outstanding
 * chat-day backlog, and whether embeddings (semantic search) are configured.
 */
export const GET = defineRoute(async () => ok(await getSummaryJobInfo()));
