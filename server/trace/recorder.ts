import "server-only";

import { randomUUID } from "node:crypto";

import { isApiError } from "@/lib/api-error";
import type {
  LlmUsage,
  Trace,
  TraceEvent,
  TraceEventType,
  TraceLevel,
  TraceTrigger,
} from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { appendTraceEvent, createTrace, setTraceInputSummary, settleTrace } from "./store";

/**
 * Trace recorder — the single entry point features use to record a meaningful
 * action. Opens a `running` trace in the in-memory store up front, appends
 * ordered events, and settles once as `success`/`error`/`skipped`. Settled
 * traces are written to their monthly log file by the store's flush loop.
 *
 * Traces are operator-facing debug data (never returned to end users), so full
 * error messages are recorded for debugging — including the `cause` chain, which
 * is where wrapped failures keep the part that actually explains them.
 */

export interface StartTraceInput {
  feature: string;
  action: string;
  trigger: TraceTrigger;
  inputSummary?: string;
}

export interface EventInput {
  message: string;
  type?: TraceEventType;
  level?: TraceLevel;
  data?: unknown;
  usage?: LlmUsage;
}

export interface FinishInput {
  outputSummary?: string;
  relatedIds?: Record<string, string[]>;
  /**
   * Correlation to settle with, for an action that only *learns* its correlation
   * by acting. A proactive send has no incoming message to key on at
   * `startTrace` — it knows its `<chatId>:<messageId>` only once Telegram accepts
   * the message — so it opens on what it has and settles on what it delivered.
   * Omitted → the correlation given at `startTrace` stands.
   */
  correlationId?: string;
}

export interface TraceRecorder {
  readonly id: string;
  /** Append an ordered event to the trace. */
  event(input: EventInput): Promise<TraceEvent>;
  /**
   * Replace the input summary, for a flow whose input is only known mid-flight
   * (a voice reply's input is its transcript, produced after the trace opened).
   */
  setInputSummary(summary: string): void;
  /** Settle the trace as successful. */
  succeed(input?: FinishInput): Promise<void>;
  /** Settle the trace as skipped (nothing to do / short-circuited). */
  skip(reason?: string, input?: FinishInput): Promise<void>;
  /** Settle the trace as failed, recording the error in the timeline. */
  fail(error: unknown, input?: FinishInput): Promise<void>;
}

/**
 * Depth cap on the cause chain — enough for the deepest real wrapping (a driver
 * error inside an ORM error inside an `ApiError`), and a guard against a cyclic
 * `cause` looping forever.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * An error's message followed by its `cause` chain. The top-level message is
 * often the least useful part of a wrapped failure — a wrapper may report
 * `Failed to …` and put the reason (`ECONNREFUSED`) in `cause`, so recording
 * only the message tells an operator what ran but never why it failed.
 */
function toErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    // A wrapper that just restates its cause adds nothing to the timeline.
    if (message && !parts.includes(message)) parts.push(message);
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return parts.join("\ncaused by: ") || String(error);
}

function toTraceError(error: unknown): NonNullable<Trace["error"]> {
  const message = toErrorMessage(error);
  if (isApiError(error)) return { code: error.code, message };
  return { message };
}

/** Begin recording a trace in the in-memory store. */
export async function startTrace(input: StartTraceInput): Promise<TraceRecorder> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  createTrace({
    id,
    feature: input.feature,
    action: input.action,
    trigger: input.trigger,
    startedAt,
    inputSummary: input.inputSummary,
  });
  // Notify live dashboards: a new (running) trace exists.
  publishEvent("traces", { feature: input.feature });

  let seq = 0;
  let settled = false;

  // Per-event publishes are throttled per trace: a reply with tool rounds emits
  // a dozen events in seconds, and each publish triggers a (debounced) refresh
  // in every open Debug tab — a full server re-render per refresh. Coalescing to
  // one publish per second per trace keeps open-trace detail views streaming
  // while capping the refresh pressure. Trailing edge included, so the last
  // event of a burst is never silently withheld.
  const PUBLISH_THROTTLE_MS = 1_000;
  let lastPublishAt = 0;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;

  /** Notify live dashboards immediately (trace opened / settled). */
  const notify = () => {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    lastPublishAt = Date.now();
    publishEvent("traces", { feature: input.feature });
  };

  /** Notify live dashboards, coalesced to one publish per throttle window. */
  const notifyThrottled = () => {
    const elapsed = Date.now() - lastPublishAt;
    if (elapsed >= PUBLISH_THROTTLE_MS) {
      notify();
      return;
    }
    if (!publishTimer) {
      publishTimer = setTimeout(notify, PUBLISH_THROTTLE_MS - elapsed);
      publishTimer.unref?.();
    }
  };

  async function appendEvent(input: EventInput): Promise<TraceEvent> {
    const event: TraceEvent = {
      id: randomUUID(),
      traceId: id,
      seq: seq++,
      ts: new Date().toISOString(),
      type: input.type ?? "step",
      level: input.level ?? "info",
      message: input.message,
      data: input.data,
      usage: input.usage,
    };
    appendTraceEvent(id, event);
    // Notify live dashboards so an open trace's detail view streams entries in
    // as they are recorded, not only when the trace settles.
    notifyThrottled();
    return event;
  }

  function ensureOpen(): void {
    if (settled) {
      throw new Error(`Trace ${id} is already settled`);
    }
  }

  /**
   * Settle the in-memory trace and notify dashboards. Shared by success/skip/fail.
   *
   * Nothing is mirrored to Postgres. Analytics used to read a compact copy of each
   * settled trace (`llm_usage` / `trace_facts`), which meant two sources of truth
   * for the same events and — because the copy was written at settle time — a lossy
   * one: it could only ever carry what the writer thought to distil. The dashboard
   * now aggregates the trace files themselves, so the trace is simply the record.
   */
  async function finalize(
    status: "success" | "error" | "skipped",
    finish: FinishInput | undefined,
    settleExtra: { outputSummary?: string; error?: Trace["error"] },
  ): Promise<void> {
    settleTrace(id, {
      status,
      finishedAt: new Date().toISOString(),
      outputSummary: settleExtra.outputSummary,
      error: settleExtra.error,
      relatedIds: finish?.relatedIds,
      correlationId: finish?.correlationId,
    });
    notify();
  }

  return {
    id,
    async event(eventInput) {
      ensureOpen();
      return appendEvent(eventInput);
    },
    setInputSummary(summary) {
      // Lenient on purpose: a late call after settle is a no-op, not a crash.
      if (!settled) setTraceInputSummary(id, summary);
    },
    async succeed(finish) {
      ensureOpen();
      settled = true;
      await finalize("success", finish, { outputSummary: finish?.outputSummary });
    },
    async skip(reason, finish) {
      ensureOpen();
      if (reason) await appendEvent({ type: "step", message: reason });
      settled = true;
      await finalize("skipped", finish, { outputSummary: finish?.outputSummary ?? reason });
    },
    async fail(error, finish) {
      ensureOpen();
      const traceError = toTraceError(error);
      await appendEvent({ type: "error", level: "error", message: traceError.message });
      settled = true;
      await finalize("error", finish, { outputSummary: finish?.outputSummary, error: traceError });
    },
  };
}
