import { getTraceDetail } from "@/server/trace";
import { defineRoute, ok } from "@/server/http";
import { requireTraceVisible } from "@/server/ownership";

/**
 * Single trace with its ordered events. `not_found` when the id is unknown —
 * or (Phase 9) not one of the acting user's own assistants' turns.
 */
export const GET = defineRoute(
  async ({ params, account }) => {
    const trace = await getTraceDetail(params.id);
    await requireTraceVisible(account, trace);
    return ok(trace);
  },
  { access: "account" },
);
