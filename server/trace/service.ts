import "server-only";

import { ApiError } from "@/lib/api-error";
import type { Trace, TraceBundle, TraceStatus, TraceTrigger } from "@/lib/trace";
import {
  getEventsForTraces,
  getTrace,
  listFeatures,
  listTraceMonths,
  listTraces,
  pruneTracesBefore,
  type PruneTracesResult,
} from "./store";
import { withTrace } from "./with-trace";

/**
 * Shared Debug service — the single boundary the Debug pages and the
 * `app/api/traces/**` handlers call to read traces. The store stays pure
 * state/IO/queries; this layer owns defaults, not-found mapping, and bundle
 * assembly so every feature's Debug view behaves identically.
 */

/** Hard cap on a single downloadable bundle so an export can't page the whole store. */
const BUNDLE_MAX = 500;

export interface TraceQuery {
  feature?: string;
  status?: TraceStatus;
  /** Every trace of one process (a turn, a job run) — exact trigger correlation. */
  correlationId?: string;
  triggerKind?: TraceTrigger["kind"];
  /** The trigger's actor (a chat id, user id, or job name), exact match. */
  actor?: string;
  limit?: number;
  offset?: number;
}

export interface TraceListView {
  /** Trace headers (no events), newest first. Not capped by default. */
  traces: Trace[];
  /** Total matching the filter. */
  total: number;
  /** Distinct feature names for the filter dropdown. */
  features: string[];
}

/**
 * Trace headers (newest first) plus the feature list that powers the Debug
 * filter. `total` always counts the whole match, so a caller can paginate; omit
 * `limit` for the uncapped read (the JSON API and bundle export).
 */
export async function getTraceList(query: TraceQuery = {}): Promise<TraceListView> {
  const [page, features] = await Promise.all([listTraces(query), listFeatures()]);
  return { traces: page.traces, total: page.total, features };
}

/** Full trace with ordered events, or a `not_found` ApiError. */
export async function getTraceDetail(id: string): Promise<Trace> {
  const trace = await getTrace(id);
  if (!trace) throw ApiError.notFound(`Trace ${id} not found`);
  return trace;
}

const bundle = (traces: Trace[]): TraceBundle => ({
  schema: "llm-tg-bot/trace-bundle@1",
  exportedAt: new Date().toISOString(),
  traces,
});

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

/** The month keys with stored trace files, ascending (the prune picker's source). */
export async function getTraceMonths(): Promise<string[]> {
  return listTraceMonths();
}

/**
 * Delete every stored trace month strictly older than `beforeMonth` — the
 * operator's manual prune (user decision, 2026-07-20: no automatic retention;
 * nothing is deleted without this explicit action). Destructive and traced: the
 * deleted months and counts are recorded in the prune's own trace.
 */
export async function pruneTraces(
  beforeMonth: string,
  trigger: TraceTrigger,
): Promise<PruneTracesResult> {
  if (!MONTH_KEY_RE.test(beforeMonth)) {
    throw ApiError.badRequest("beforeMonth must be a YYYY-MM month key");
  }
  return withTrace(
    {
      feature: "traces",
      action: "prune",
      trigger,
      inputSummary: `delete stored months before ${beforeMonth}`,
    },
    async (trace) => {
      const result = await pruneTracesBefore(beforeMonth);
      await trace.event({
        type: "db",
        message: "month files deleted",
        data: { beforeMonth, months: result.months, traces: result.traces },
      });
      await trace.succeed({
        outputSummary: `${result.months.length} month file(s) deleted, ${result.traces} trace(s) removed`,
      });
      return result;
    },
  );
}

/** Downloadable bundle for a single trace (with its events). */
export async function buildTraceBundle(id: string): Promise<TraceBundle> {
  return bundle([await getTraceDetail(id)]);
}

/**
 * Downloadable bundle for a filtered set of traces, each with its events. Capped
 * at {@link BUNDLE_MAX} newest matches; events are fetched in one grouped query.
 */
export async function buildTraceListBundle(query: TraceQuery = {}): Promise<TraceBundle> {
  const { traces: headers } = await listTraces({ ...query, limit: BUNDLE_MAX, offset: 0 });
  const events = await getEventsForTraces(headers.map((t) => t.id));
  const full = headers.map((header) => ({ ...header, events: events.get(header.id) ?? [] }));
  return bundle(full);
}
