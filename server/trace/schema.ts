import { z } from "zod";

import { traceStatusSchema, traceTriggerSchema } from "@/lib/trace";

/**
 * Query schema for the Debug trace list and bundle-export endpoints. Coerces the
 * string search params into typed filters. Shared by the `app/api/traces/**`
 * Route Handlers and the Server Component Debug pages so both parse identically.
 */
export const traceQuerySchema = z.object({
  feature: z.string().min(1).optional(),
  status: traceStatusSchema.optional(),
  /** Every trace of one process (a turn, a job run) — see `TraceTrigger.correlationId`. */
  correlationId: z.string().min(1).optional(),
  triggerKind: traceTriggerSchema.shape.kind.optional(),
  /** The trigger's actor (a chat id, user id, or job name), exact match. */
  actor: z.string().min(1).optional(),
  /** A row id under `trace.relatedIds` (any table) — everything about one record. */
  relatedId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type TraceQueryInput = z.infer<typeof traceQuerySchema>;
