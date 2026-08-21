import { getMemoryJobInfo } from "@/features/memory/server/scheduler";
import { getMemoryView } from "@/features/memory/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Memory read API: the aggregate dashboard view (pending notes, per-person
 * documents, general facts) plus the nightly consolidation job's status.
 */
export const GET = defineRoute(async () => {
  const [view, job] = await Promise.all([getMemoryView(), getMemoryJobInfo()]);
  return ok({ ...view, job });
});
