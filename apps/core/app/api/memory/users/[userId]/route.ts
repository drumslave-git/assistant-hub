import { updateUserMemorySchema } from "@/features/memory/server/schema";
import { editUserMemory, forgetUser } from "@/features/memory/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-person memory API: rewrite one person's memory document (re-embedding
 * it), or forget them entirely — which also drops their pending notes, by cascade.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateUserMemorySchema);
  return ok(await editUserMemory(params.userId, input));
});

export const DELETE = defineRoute(async ({ params }) => {
  await forgetUser(params.userId);
  return ok({ deleted: true });
});
