import { discardMemoryEntry } from "@/features/memory/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Pending-note API: discard a note before the nightly job folds it into durable
 * memory — the operator's chance to catch a fact the bot should not have saved.
 */
export const DELETE = defineRoute(async ({ params }) => {
  await discardMemoryEntry(params.id);
  return ok({ deleted: true });
});
