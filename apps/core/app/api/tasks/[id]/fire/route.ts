import { getTaskById } from "@/features/tasks/server/repository";
import { manualFireTask } from "@/features/tasks/server/scheduler";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok } from "@/server/http";
import { requireAssistantOwnership } from "@/server/ownership";
import { getStoreDb } from "@/server/store/db";

/**
 * Manual fire ("Fire now"). Runs one timed task's fire immediately without
 * touching its schedule — a one-shot survives, `next_run_at` stays put, and
 * the run is traced as `tasks`/`manual-fire`. Account level since Phase 9,
 * gated through the task's assistant.
 */
export const POST = defineRoute(
  async ({ params, account }) => {
    const task = await getTaskById(getStoreDb(), params.id);
    if (!task) throw ApiError.notFound("Unknown task");
    await requireAssistantOwnership(account, task.assistantId);
    return ok(await manualFireTask(params.id, { kind: "dashboard" }));
  },
  { access: "account" },
);
