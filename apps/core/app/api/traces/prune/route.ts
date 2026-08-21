import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import { pruneTraces } from "@/server/trace";

/**
 * Manual trace prune: delete every stored month file strictly older than the
 * given `YYYY-MM` key. Destructive — trace files are the only copy of full
 * request/response bodies — and manual-only by user decision (2026-07-20): no
 * automatic retention exists, so nothing is deleted except through this call.
 */
const pruneSchema = z.object({
  beforeMonth: z.string().regex(/^\d{4}-\d{2}$/, "beforeMonth must be YYYY-MM"),
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, pruneSchema);
  return ok(await pruneTraces(input.beforeMonth, { kind: "dashboard" }));
});
