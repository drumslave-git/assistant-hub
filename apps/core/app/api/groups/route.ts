import { listDirectoryChats } from "@/server/source/directory";
import { defineRoute, ok } from "@/server/http";

/**
 * The aggregated conversation directory: every chat every registered source
 * app carries, tagged with its origin, plus the sources that could not be
 * read. Thin handler — the aggregation seam owns the fan-out and shaping.
 */
export const GET = defineRoute(async () => ok(await listDirectoryChats()));
