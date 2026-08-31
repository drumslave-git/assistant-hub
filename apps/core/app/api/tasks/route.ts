import { createTaskSchema } from "@/features/tasks/server/schema";
import { createTaskService, getTasksView } from "@/features/tasks/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";
import { isRestricted, ownedAssistantIds, requireAssistantOwnership } from "@/server/ownership";

/**
 * Tasks collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording. Account level since Phase 9: a
 * user-role account sees and authors tasks of its OWN assistants only;
 * admins keep the whole board.
 */
export const GET = defineRoute(
  async ({ account }) => {
    const view = await getTasksView();
    if (!isRestricted(account)) return ok(view);
    const owned = (await ownedAssistantIds(account))!;
    return ok(view.filter((task) => owned.has(task.assistantId)));
  },
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, account }) => {
    const input = await parseJson(request, createTaskSchema);
    await requireAssistantOwnership(account, input.assistantId);
    return ok(await createTaskService(input, { kind: "dashboard" }), { status: 201 });
  },
  { access: "account" },
);
