import { getTaskSchedulerInfo, runTaskSchedulerNow } from "@/features/tasks/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * Tasks poller API. `GET` reports the job info the dashboard card renders
 * (ticker status, whether firing is paused, the overdue backlog); `POST`
 * triggers one poll tick immediately (dashboard "Run now") and reports it
 * again. Only tasks that are actually due fire — and none do while maintenance
 * mode is on, which is what `paused` surfaces.
 */
export const GET = defineRoute(async () => ok(await getTaskSchedulerInfo()));

export const POST = defineRoute(async () => {
  await runTaskSchedulerNow();
  return ok(await getTaskSchedulerInfo());
});
