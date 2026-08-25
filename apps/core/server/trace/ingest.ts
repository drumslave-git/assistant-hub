import "server-only";

import { randomUUID } from "node:crypto";

import type { SourceTrace } from "@assistant-hub/contracts";

import { publishEvent } from "@/server/realtime/hub";

import { appendTraceEvent, createTrace, settleTrace } from "./store";

/**
 * Persist one settled source-app trace (a `trace.recorded` bus event) into
 * this — the only — trace store (PLAN "Traces and debug": apps never write
 * trace rows themselves; the debug explorer reads exactly one place).
 *
 * The trace arrives complete, so it passes through the store's normal
 * open→events→settle lifecycle in one go: it lands in the pending-flush
 * buffer exactly like a locally recorded trace, with the source's own
 * timestamps preserved on every line. Its correlation id is whatever the
 * source stamped, which is how a turn's cross-app flow (tg inbound → core
 * reply → tg delivery) groups under one correlation filter.
 */
export function ingestSourceTrace(trace: SourceTrace): void {
  const id = randomUUID();
  createTrace({
    id,
    feature: trace.feature,
    action: trace.action,
    assistantId: trace.assistantId,
    trigger: trace.trigger,
    startedAt: trace.startedAt,
    inputSummary: trace.inputSummary,
  });
  for (const event of trace.events) {
    appendTraceEvent(id, {
      id: randomUUID(),
      traceId: id,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      level: event.level,
      message: event.message,
      ...(event.data !== undefined ? { data: event.data } : {}),
    });
  }
  settleTrace(id, {
    status: trace.status,
    finishedAt: trace.finishedAt,
    outputSummary: trace.outputSummary,
    error: trace.error ?? null,
    relatedIds: trace.relatedIds,
  });
  publishEvent("traces", { feature: trace.feature });
}
