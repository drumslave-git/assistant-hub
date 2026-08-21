import { listUsers } from "@/features/known-users/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Known-users API. Thin handler: the service owns persistence and shaping.
 */
export const GET = defineRoute(async () => ok(await listUsers()));
