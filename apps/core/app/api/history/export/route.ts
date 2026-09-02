import { exportHistoryQuerySchema } from "@/features/history/server/schema";
import { exportHistoryCsv } from "@/features/history/server/transfer";
import { csvDownload, defineRoute, parseQuery } from "@/server/http";

/**
 * CSV export of the history mirror — every chat, or one chat via `?chatRef=`.
 * Thin handler: the service owns serialization.
 */
export const GET = defineRoute(async ({ request }) => {
  const { chatRef } = parseQuery(request, exportHistoryQuerySchema);
  const csv = await exportHistoryCsv(chatRef);
  const scope = chatRef ? `chat-${chatRef.replace(/[^A-Za-z0-9_-]+/g, "-")}` : "all";
  return csvDownload(csv, `history-${scope}.csv`);
});
