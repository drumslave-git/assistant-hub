import { z } from "zod";

import { enqueueBrowserRun, getBrowserAgentRuns } from "@/features/browser-agent/server/service";
import { emitRunEnqueued } from "@/features/browser-agent/server/signal";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Browser-agent runs API. `GET` lists all runs for the dashboard; `POST` queues a
 * dashboard-started run (no chat to deliver to — the report is stored on the run).
 * Thin handlers: the service owns persistence, the runner owns execution.
 */
export const GET = defineRoute(async () => ok({ runs: await getBrowserAgentRuns() }));

const createRunSchema = z.object({
  goal: z.string().trim().min(4).max(4000),
});

export const POST = defineRoute(async ({ request }) => {
  const { goal } = await parseJson(request, createRunSchema);
  // Dashboard runs are the operator's own — treat as owner (downloads enabled).
  const run = await enqueueBrowserRun({ goal, chatId: null, isOwner: true });
  emitRunEnqueued();
  return ok(run, { status: 201 });
});
