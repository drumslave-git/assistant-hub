import { getTraceDetail } from "@/server/trace";
import { defineRoute, ok } from "@/server/http";

/** Single trace with its ordered events. `not_found` when the id is unknown. */
export const GET = defineRoute(async ({ params }) => ok(await getTraceDetail(params.id)));
