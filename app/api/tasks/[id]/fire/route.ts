import { manualFireTask } from "@/features/tasks/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * Manual fire ("Fire now"). Runs one timed task's fire immediately without
 * touching its schedule — a one-shot survives, `next_run_at` stays put, and the
 * run is traced as `tasks`/`manual-fire`. The service owns validation (timed
 * kinds only) and error mapping.
 */
export const POST = defineRoute(async ({ params }) => {
  return ok(await manualFireTask(params.id, { kind: "dashboard" }));
});
