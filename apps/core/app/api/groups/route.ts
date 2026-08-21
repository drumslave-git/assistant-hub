import { listGroups } from "@/features/known-groups/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Known-groups API. Thin handler: the service owns persistence and shaping.
 */
export const GET = defineRoute(async () => ok(await listGroups()));
