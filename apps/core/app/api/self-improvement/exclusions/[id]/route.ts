import { removeAddressingExclusion } from "@/features/self-improvement/server/service";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok } from "@/server/http";

/**
 * Addressing-exclusion API: drop a word the chat reported as "not the bot's
 * name". The operator's undo — after this the analyzer may match that word
 * again.
 */
export const DELETE = defineRoute(async ({ params }) => {
  const removed = await removeAddressingExclusion(params.id);
  if (!removed) throw ApiError.notFound("Exclusion not found");
  return ok({ deleted: true, exclusion: removed });
});
