import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SourceId } from "./scoped-ref";
import { eventEnvelopeSchema, sourceIdSchema } from "./source-events";

/**
 * The cross-app trace contract (PLAN "Traces and debug"): tracing is unified
 * and core-owned — apps never write trace rows themselves. A source app
 * records through {@link createSourceTraceRecorder}, which buffers the whole
 * action locally and publishes ONE `trace.recorded` bus event when it
 * settles; the core persists it into its trace store, and the debug explorer
 * reads exactly one place. Whole-trace-on-settle keeps the bus free of
 * per-event streaming state — source actions are short (a send, an ingest, a
 * feedback press), and a running remote trace nobody can append to across a
 * process boundary would only lie about liveness.
 *
 * The enums mirror the core's trace vocabulary on purpose: a source must not
 * invent event types or levels — consistent debug rendering depends on the
 * shared set.
 */

export const sourceTraceEventTypeSchema = z.enum([
  "step",
  "input",
  "output",
  "external_call",
  "llm_request",
  "llm_response",
  "db",
  "error",
]);

export const sourceTraceLevelSchema = z.enum(["debug", "info", "success", "warn", "error"]);

/** One buffered event line; `seq` orders it within its trace. */
export const sourceTraceEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  type: sourceTraceEventTypeSchema,
  level: sourceTraceLevelSchema,
  message: z.string().min(1),
  data: z.unknown().optional(),
});

/** A complete, settled trace as a source app hands it to the core. */
export const sourceTraceSchema = z.object({
  feature: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["success", "error", "skipped"]),
  trigger: z.object({
    kind: z.enum(["telegram", "dashboard", "cron", "system", "api", "test"]),
    actor: z.string().optional(),
    correlationId: z.string().optional(),
  }),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).nullable(),
  relatedIds: z.record(z.string(), z.array(z.string())).optional(),
  events: z.array(sourceTraceEventSchema),
});

export type SourceTrace = z.infer<typeof sourceTraceSchema>;

/** `trace.recorded` — one settled source-side trace, for the core to persist. */
export const traceRecordedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("trace.recorded"),
  source: sourceIdSchema,
  trace: sourceTraceSchema,
});

export type TraceRecordedEvent = z.infer<typeof traceRecordedEventSchema>;

export interface SourceTraceEventInput {
  message: string;
  type?: z.infer<typeof sourceTraceEventTypeSchema>;
  level?: z.infer<typeof sourceTraceLevelSchema>;
  data?: unknown;
}

export interface SourceTraceFinishInput {
  outputSummary?: string;
  relatedIds?: Record<string, string[]>;
  /** Settle-time correlation, for an action that learns it by acting. */
  correlationId?: string;
}

/** The recording surface — the core recorder's shape, minus LLM usage. */
export interface SourceTraceRecorder {
  event(input: SourceTraceEventInput): void;
  setInputSummary(summary: string): void;
  relate(key: string, ids: string[]): void;
  succeed(input?: SourceTraceFinishInput): Promise<void>;
  skip(reason?: string, input?: SourceTraceFinishInput): Promise<void>;
  fail(error: unknown, input?: SourceTraceFinishInput): Promise<void>;
}

export interface StartSourceTraceInput {
  feature: string;
  action: string;
  trigger: SourceTrace["trigger"];
  inputSummary?: string;
}

export interface SourceTraceClient {
  startTrace(input: StartSourceTraceInput): SourceTraceRecorder;
}

/**
 * A source app's trace client. `publish` delivers one built `trace.recorded`
 * event; it is awaited on settle but a failure must be handled by the caller
 * (typically logged) — recording must never break the action it describes.
 */
export function createSourceTraceRecorder(input: {
  source: SourceId;
  publish: (event: TraceRecordedEvent) => Promise<void>;
}): SourceTraceClient {
  return {
    startTrace(start) {
      const startedAt = new Date().toISOString();
      const events: SourceTrace["events"] = [];
      let inputSummary = start.inputSummary;
      const related = new Map<string, Set<string>>();
      let settled = false;

      const settle = async (
        status: SourceTrace["status"],
        error: SourceTrace["error"],
        finish?: SourceTraceFinishInput,
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        for (const [key, ids] of Object.entries(finish?.relatedIds ?? {})) {
          const set = related.get(key) ?? new Set();
          for (const id of ids) set.add(id);
          related.set(key, set);
        }
        const relatedIds = Object.fromEntries(
          [...related.entries()].map(([key, ids]) => [key, [...ids]]),
        );
        // Like the core recorder: every trace carries a correlation — an
        // action correlating only to itself gets a fresh id, and the Debug
        // correlation filter never comes up empty.
        const correlationId =
          finish?.correlationId ?? start.trigger.correlationId ?? randomUUID();
        await input.publish(
          traceRecordedEventSchema.parse({
            v: 1,
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            correlationId,
            type: "trace.recorded",
            source: input.source,
            trace: {
              feature: start.feature,
              action: start.action,
              status,
              trigger: { ...start.trigger, correlationId },
              startedAt,
              finishedAt: new Date().toISOString(),
              ...(inputSummary !== undefined ? { inputSummary } : {}),
              ...(finish?.outputSummary !== undefined
                ? { outputSummary: finish.outputSummary }
                : {}),
              error,
              ...(Object.keys(relatedIds).length > 0 ? { relatedIds } : {}),
              events,
            },
          } satisfies TraceRecordedEvent),
        );
      };

      return {
        event(event) {
          if (settled) return;
          events.push({
            seq: events.length,
            ts: new Date().toISOString(),
            type: event.type ?? "step",
            level: event.level ?? "info",
            message: event.message,
            ...(event.data !== undefined ? { data: event.data } : {}),
          });
        },
        setInputSummary(summary) {
          if (!settled) inputSummary = summary;
        },
        relate(key, ids) {
          if (settled) return;
          const set = related.get(key) ?? new Set();
          for (const id of ids) set.add(id);
          related.set(key, set);
        },
        succeed: (finish) => settle("success", null, finish),
        async skip(reason, finish) {
          await settle("skipped", null, {
            ...finish,
            outputSummary: finish?.outputSummary ?? reason,
          });
        },
        async fail(error, finish) {
          const message = error instanceof Error ? error.message : String(error);
          events.push({
            seq: events.length,
            ts: new Date().toISOString(),
            type: "error",
            level: "error",
            message,
          });
          await settle("error", { message }, finish);
        },
      };
    },
  };
}
