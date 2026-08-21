import { getSelfImprovementJobInfo } from "@/features/self-improvement/server/scheduler";
import { getSelfImprovementView } from "@/features/self-improvement/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Self-improvement read API: the aggregate dashboard view (feedbacks, latest
 * preferences per user, latest correction) plus the daily job's status.
 */
export const GET = defineRoute(async () => {
  const [view, job] = await Promise.all([getSelfImprovementView(), getSelfImprovementJobInfo()]);
  return ok({ ...view, job });
});
