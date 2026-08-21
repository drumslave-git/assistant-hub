import { exportHistoryQuerySchema } from "@/features/history/server/schema";
import { exportHistoryCsv } from "@/features/history/server/transfer";
import { csvDownload, defineRoute, parseQuery } from "@/server/http";

/**
 * CSV export of the history mirror — every chat, or one chat via `?chatId=`.
 * Thin handler: the service owns serialization.
 */
export const GET = defineRoute(async ({ request }) => {
  const { chatId } = parseQuery(request, exportHistoryQuerySchema);
  const csv = await exportHistoryCsv(chatId);
  const scope = chatId ? `chat-${chatId}` : "all";
  return csvDownload(csv, `history-${scope}.csv`);
});
