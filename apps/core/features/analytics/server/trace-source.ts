import "server-only";

import { normalizeModelName, UNKNOWN_MODEL } from "@/features/self-improvement/model-name";
import type { Trace } from "@/lib/trace";
import { scanTraces } from "@/server/trace";

import { callKindOf, type LlmCallKindId } from "../llm-call-kind";
import { bucketKeyOfInstant } from "../period";
import type { CallKindStat, Granularity, ModelStat } from "../types";

/**
 * Analytics over the **trace files** — the traffic, token, and model-performance
 * source.
 *
 * The traces are the record of what the bot did: every LLM round, its model, its
 * tokens, its latency, and (now) what the call was for. Analytics used to read a
 * compact Postgres mirror of this written at settle time, which was a second source
 * of truth that could only carry what the writer thought to distil — and it distilled
 * away exactly the detail Model performance needs. This module reads the real thing.
 *
 * The shape is deliberately: **scan once → flatten to rows → aggregate**. The
 * service fetches the period's traces once ({@link scanScopeTraces}) and passes
 * them into the pure aggregators, so one metrics request costs one store scan no
 * matter how many readings it takes. Every caller filters and buckets the same
 * flat row type, so a chat filter or a bucket key means the same thing on every
 * card.
 */

/** One LLM round pulled out of a trace — the atom every trace metric aggregates. */
export interface UsageRow {
  /**
   * When the work started.
   *
   * The *trace's* start, not the event's: a trace is one unit of work, and a reply
   * whose tool loop spans an hour boundary should account to the message it was
   * answering rather than smearing across two buckets.
   */
  startedAt: Date;
  model: string;
  callKind: LlmCallKindId;
  feature: string;
  /** Telegram user id that triggered the work, when there was one. */
  actor: string | null;
  /** `<chatId>:<messageId>` for message-driven work. */
  correlationId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null when the provider reported no latency. */
  latencyMs: number | null;
}

/** Filters shared by every trace-sourced read. */
export interface TraceScope {
  startUtc: Date;
  /** Exclusive. */
  endUtc: Date;
  chatId?: string | null;
  userId?: string | null;
}

/**
 * The model a round is attributed to: the id that was *requested*.
 *
 * `usage.model` holds the requested id, so this is normally just its clean name. The
 * bundle branch handles rows recorded when it held the provider's answer instead:
 * Docker Model Runner resolves a tag to the bundle path of the file it loaded
 * (`/models/bundles/sha256/<digest>/model/<file>.gguf`). The digest **is** the model
 * id, so such a row is a resolved tag, not a different model — attributing it to the
 * filename split one configured model across two rows on the dashboard. Old rows
 * carry no record of the requested tag, so the digest is the honest thing to show:
 * it identifies the bundle exactly, whereas the filename inside it is a packaging
 * detail and the tag would be a guess (`docker model ls` maps it back).
 */
export function attributedModel(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  const bundle = /^\/models\/bundles\/sha256\/([0-9a-f]{12})/.exec(trimmed);
  if (bundle) return `bundle ${bundle[1]}`;
  return normalizeModelName(trimmed);
}

/** Whether a trace belongs to the requested chat/user scope. */
function inScope(trace: Trace, scope: TraceScope): boolean {
  if (scope.chatId && !trace.trigger.correlationId?.startsWith(`${scope.chatId}:`)) return false;
  if (scope.userId && trace.trigger.actor !== scope.userId) return false;
  return true;
}

/** One scan of the period's traces — the input every aggregator below shares. */
export async function scanScopeTraces(range: { startUtc: Date; endUtc: Date }): Promise<Trace[]> {
  return scanTraces({ startUtc: range.startUtc, endUtc: range.endUtc });
}

/** Every LLM round recorded in the scanned traces, flattened. */
export function usageRowsFrom(traces: Trace[], scope: TraceScope): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const trace of traces) {
    if (!inScope(trace, scope)) continue;
    const startedAt = new Date(trace.startedAt);
    for (const event of trace.events) {
      if (event.type !== "llm_response" || !event.usage) continue;
      const callKind = callKindOf(trace, event);
      // A kind we cannot name is skipped rather than bucketed as "other": an
      // invented category on a performance dashboard is worse than an absent row.
      if (!callKind) continue;
      rows.push({
        startedAt,
        model: attributedModel(event.usage.model),
        callKind,
        feature: trace.feature,
        actor: trace.trigger.actor ?? null,
        correlationId: trace.trigger.correlationId ?? null,
        promptTokens: event.usage.promptTokens ?? 0,
        completionTokens: event.usage.completionTokens ?? 0,
        totalTokens: event.usage.totalTokens ?? 0,
        latencyMs: event.usage.latencyMs ?? null,
      });
    }
  }
  return rows;
}

/** Per-sub-bucket token totals, keyed by bucket. */
export function bucketTokens(
  rows: UsageRow[],
  bucketUnit: Granularity,
  timeZone: string,
): Map<string, { processed: number; generated: number }> {
  const out = new Map<string, { processed: number; generated: number }>();
  for (const row of rows) {
    const key = bucketKeyOfInstant(row.startedAt, bucketUnit, timeZone);
    const entry = out.get(key) ?? { processed: 0, generated: 0 };
    entry.processed += row.promptTokens;
    entry.generated += row.completionTokens;
    out.set(key, entry);
  }
  return out;
}

/** Whole-period token totals. */
export function totalTokens(rows: UsageRow[]): { processed: number; generated: number } {
  return rows.reduce(
    (acc, r) => ({
      processed: acc.processed + r.promptTokens,
      generated: acc.generated + r.completionTokens,
    }),
    { processed: 0, generated: 0 },
  );
}

/** Prompt tokens per triggering user, for the Top users card. */
export function tokensByActor(rows: UsageRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.actor) continue;
    out.set(row.actor, (out.get(row.actor) ?? 0) + row.promptTokens);
  }
  return out;
}

/** Completion tokens per second of latency — a ratio of sums, safe across a mix. */
function throughput(completionTokens: number, latencySumMs: number): number | null {
  if (latencySumMs <= 0) return null;
  return Math.round((completionTokens / (latencySumMs / 1000)) * 10) / 10;
}

/**
 * Nearest-rank percentile over a sorted array. Nearest-rank rather than an
 * interpolated one because every value here is an observed latency, and a p95 that
 * no call actually took is harder to act on than one that did.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(p * sortedAsc.length);
  return Math.round(sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1]);
}

function statFor(callKind: LlmCallKindId, rows: UsageRow[]): CallKindStat {
  const latencies = rows
    .map((r) => r.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const totalLatencyMs = latencies.reduce((a, v) => a + v, 0);
  const completionTokens = rows.reduce((a, r) => a + r.completionTokens, 0);
  return {
    callKind,
    calls: rows.length,
    avgLatencyMs: latencies.length > 0 ? Math.round(totalLatencyMs / latencies.length) : 0,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    totalLatencyMs,
    promptTokens: rows.reduce((a, r) => a + r.promptTokens, 0),
    completionTokens,
    totalTokens: rows.reduce((a, r) => a + r.totalTokens, 0),
    tokensPerSec: throughput(completionTokens, totalLatencyMs),
  };
}

/**
 * Per-model stats broken down by call kind, ordered so the **bottleneck comes
 * first**: models and kinds are sorted by total wall time contributed, not by call
 * count. A 400 ms call made ten thousand times costs more than a 20 s call made
 * twice, and sorting by frequency buries exactly the row an operator is hunting for.
 */
export function buildModelStats(rows: UsageRow[]): ModelStat[] {
  const byModel = new Map<string, Map<LlmCallKindId, UsageRow[]>>();
  for (const row of rows) {
    const model = row.model || UNKNOWN_MODEL;
    const kinds = byModel.get(model) ?? new Map<LlmCallKindId, UsageRow[]>();
    const list = kinds.get(row.callKind) ?? [];
    list.push(row);
    kinds.set(row.callKind, list);
    byModel.set(model, kinds);
  }

  return [...byModel.entries()]
    .map(([model, kinds]) => {
      const callKinds = [...kinds.entries()]
        .map(([kind, kindRows]) => statFor(kind, kindRows))
        .sort((a, b) => b.totalLatencyMs - a.totalLatencyMs);
      const sum = (pick: (s: CallKindStat) => number) => callKinds.reduce((a, s) => a + pick(s), 0);
      const completionTokens = sum((s) => s.completionTokens);
      const totalLatencyMs = sum((s) => s.totalLatencyMs);
      return {
        model,
        calls: sum((s) => s.calls),
        promptTokens: sum((s) => s.promptTokens),
        completionTokens,
        totalTokens: sum((s) => s.totalTokens),
        totalLatencyMs,
        tokensPerSec: throughput(completionTokens, totalLatencyMs),
        callKinds,
      };
    })
    .sort((a, b) => b.totalLatencyMs - a.totalLatencyMs);
}

export interface TrafficTotals {
  /** Messages the bot opened a trace for — its actual workload. */
  handled: number;
  /** Traces that settled successfully. */
  replied: number;
  /** Traces that settled with an error. */
  failed: number;
  /** Distinct triggering users. */
  activeUsers: number;
  /** Images described in the period. */
  images: number;
}

/**
 * The Traffic tiles, from traces.
 *
 * "Messages" here is what the bot *worked on*, not every message that existed — a
 * group message the bot was never addressed in opens no trace at all. That is the
 * useful reading of traffic for an operator (load, success rate), and the raw
 * message counts are what the Message volume chart reports from history.
 */
export function trafficTotalsFrom(traces: Trace[], scope: TraceScope): TrafficTotals {
  const actors = new Set<string>();
  let handled = 0;
  let replied = 0;
  let failed = 0;
  let images = 0;

  for (const trace of traces) {
    if (!inScope(trace, scope)) continue;
    if (trace.feature === "vision" && trace.action === "describe") images += 1;
    if (trace.feature !== "bot-messaging") continue;
    handled += 1;
    if (trace.status === "success") replied += 1;
    if (trace.status === "error") failed += 1;
    if (trace.trigger.actor) actors.add(trace.trigger.actor);
  }

  return { handled, replied, failed, activeUsers: actors.size, images };
}

/**
 * The sub-bucket keys that hold any trace activity — the calendar's data marks for
 * trace-sourced cards.
 */
export function traceAvailabilityFrom(
  traces: Trace[],
  params: { bucketUnit: Granularity; timeZone: string },
): string[] {
  const keys = new Set<string>();
  for (const trace of traces) {
    keys.add(bucketKeyOfInstant(new Date(trace.startedAt), params.bucketUnit, params.timeZone));
  }
  return [...keys].sort();
}
