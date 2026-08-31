import { getTaskById } from "@/features/tasks/server/repository";
import { updateTaskSchema } from "@/features/tasks/server/schema";
import { editTaskService, removeTaskService } from "@/features/tasks/server/service";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import { requireAssistantOwnership, type Actor } from "@/server/ownership";
import { getStoreDb } from "@/server/store/db";

/**
 * Single-task API. Thin handlers: shared wrappers own validation and error
 * mapping; the service owns persistence and trace recording. Account level
 * since Phase 9, gated through the task's assistant — a user-role account
 * touches only its own assistants' tasks.
 */
async function requireOwnTask(account: Actor | null, taskId: string): Promise<void> {
  const task = await getTaskById(getStoreDb(), taskId);
  if (!task) throw ApiError.notFound("Unknown task");
  await requireAssistantOwnership(account, task.assistantId);
}

export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnTask(account, params.id);
    const input = await parseJson(request, updateTaskSchema);
    return ok(await editTaskService(params.id, input, { kind: "dashboard" }));
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await requireOwnTask(account, params.id);
    await removeTaskService(params.id, { kind: "dashboard" });
    return ok({ deleted: true });
  },
  { access: "account" },
);
