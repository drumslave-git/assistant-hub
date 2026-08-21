import { listBackendModels } from "@/features/backends/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * The models one stored backend serves — feeds the Settings role dropdowns when
 * the operator picks a backend the page did not preload. Throws a clean error
 * on an unreachable endpoint so the form can say why the list is empty.
 */
export const GET = defineRoute(async ({ params }) => ok(await listBackendModels(params.id)));
