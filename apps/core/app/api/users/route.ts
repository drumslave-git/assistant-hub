import { listDirectoryUsers } from "@/server/source/directory";
import { defineRoute, ok } from "@/server/http";

/**
 * The aggregated people directory: every person every registered source app
 * knows, tagged with its origin, plus the sources that could not be read.
 * Thin handler — the aggregation seam owns the fan-out and shaping.
 */
export const GET = defineRoute(async () => ok(await listDirectoryUsers()));
