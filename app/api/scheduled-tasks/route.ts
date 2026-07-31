import { createScheduledTaskSchema } from "@/features/scheduled-tasks/server/schema";
import {
  createScheduledTaskService,
  getScheduledTasks,
} from "@/features/scheduled-tasks/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Scheduled-tasks collection API. Thin handlers: the service owns schedule
 * validation, persistence, and trace recording.
 */
export const GET = defineRoute(async () => ok({ tasks: await getScheduledTasks() }));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createScheduledTaskSchema);
  const task = await createScheduledTaskService(
    {
      chatId: input.chatId,
      threadId: input.threadId ?? null,
      createdByUserId: null,
      instruction: input.instruction,
      context: input.context ?? null,
      scheduleKind: input.scheduleKind,
      timeOfDay: input.timeOfDay,
      weekdays: input.weekdays,
      runDate: input.runDate ?? null,
      enabled: input.enabled,
    },
    { kind: "dashboard" },
  );
  return ok(task, { status: 201 });
});
