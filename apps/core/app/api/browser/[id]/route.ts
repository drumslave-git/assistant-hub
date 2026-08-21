import { getBrowserAgentRunView } from "@/features/browser-agent/server/service";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok } from "@/server/http";

/** One browser-agent run with its screenshot sequence numbers. */
export const GET = defineRoute(async ({ params }) => {
  const run = await getBrowserAgentRunView(params.id);
  if (!run) throw ApiError.notFound("Browser run not found");
  return ok(run);
});
