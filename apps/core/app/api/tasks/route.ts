import { createTaskSchema } from "@/features/tasks/server/schema";
import { createTaskService, getTasksView } from "@/features/tasks/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Tasks collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording. The dashboard is operator-only, so it may
 * author any scope — including the global one a chat cannot write.
 */
export const GET = defineRoute(async () => ok(await getTasksView()));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createTaskSchema);
  return ok(await createTaskService(input, { kind: "dashboard" }), { status: 201 });
});
