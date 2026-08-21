import { importHistorySchema } from "@/features/history/server/schema";
import { importHistoryCsv } from "@/features/history/server/transfer";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * CSV import into the history mirror. Thin handler: the service owns parsing,
 * validation, duplicate skipping, and trace recording.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, importHistorySchema);
  return ok(await importHistoryCsv(input, { kind: "dashboard" }));
});
