import { updateTaskSchema } from "@/features/tasks/server/schema";
import { editTaskService, removeTaskService } from "@/features/tasks/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-task API. Thin handlers: shared wrappers own validation and error
 * mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateTaskSchema);
  return ok(await editTaskService(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeTaskService(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
