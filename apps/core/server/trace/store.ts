import "server-only";

import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { tracesDir } from "@/server/paths";
import type { Trace, TraceEvent, TraceStatus, TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";

/**
 * File-backed trace store — the single backend behind the shared trace contract,
 * replacing the former Postgres tables. Traces live in memory while they are
 * mutable (`running`) and are written to disk exactly once, when they settle
 * (`success`/`error`/`skipped`). Because a written record is immutable, each
 * month's file is a plain append-only NDJSON log — one JSON `Trace` (header +
 * embedded events) per line — with no rewrite, fold, or compaction.
 *
 * A trace lives in exactly one of three places, unioned on read:
 *   1. `open`    — running, RAM only, never on disk (a crash drops it).
 *   2. `pending` — settled, not yet flushed (lost on hard crash; ≤ one flush
 *                  interval, and a graceful shutdown flushes first).
 *   3. months    — flushed to `traces-YYYY-MM.ndjson` and cached in `months`.
 *
 * The month cache is two-tier so months of history do not pin their full event
 * bodies (complete LLM request/response payloads) in the heap forever:
 * **headers** (events dropped) stay cached for every loaded month — the Debug
 * list and correlation lookups need only those — while **full** months (with
 * events) are kept for at most {@link MAX_FULL_MONTHS} at a time, evicted back
 * to headers least-recently-used. Range reads ({@link scanTraces}) load only
 * the months their range intersects.
 *
 * Held on a `globalThis` singleton (like `server/realtime/hub.ts`) so the writer
 * (feature/route/poller bundles) and the boot-owned flush timer
 * (`instrumentation` → `register-node`) share one instance across Next bundles
 * and dev hot-reload. In-process only: this matches the single self-hosted
 * container model. Multiple replicas would need an external store behind this
 * same API.
 */

/** Flush period. A code constant, not a setting. */
const FLUSH_MS = 60_000;

/** How many months may keep their events in RAM at once (headers always stay). */
const MAX_FULL_MONTHS = 3;

const STORE_KEY = Symbol.for("assistant-hub.trace.store");

/** One correlation-id index entry — enough to rank newest and filter by feature. */
interface CorrelationEntry {
  id: string;
  feature: string;
  startedAt: string;
}

interface TraceStore {
  /** Running traces, still mutable. */
  open: Map<string, Trace>;
  /** Settled traces not yet written to disk. */
  pending: Map<string, Trace>;
  /**
   * Flushed traces cached per `YYYY-MM`, mirroring the on-disk file. Header-only
   * (events dropped) unless the key is in {@link TraceStore.fullMonths}.
   */
  months: Map<string, Trace[]>;
  /** Months cached at least as headers (empty/missing files count as loaded). */
  loaded: Set<string>;
  /**
   * The month keys on disk, cached so a list read does not `readdir` per request.
   * Only this process writes the directory (flush creates months, prune deletes
   * them), and both invalidate this — so the cache cannot go stale behind us.
   */
  monthKeys: string[] | null;
  /**
   * The in-flight (or settled) header-index build. Every list read awaits this
   * one promise instead of starting its own scan, so N concurrent dashboard
   * requests during a cold start cost one pass over the month files, not N.
   * Reset to null on failure so a transient IO error is retried.
   */
  headerIndex: Promise<void> | null;
  /** Months cached WITH events, least-recently-used first. */
  fullMonths: string[];
  /** Newest-first view over every cached flushed trace; null when stale. */
  sortedFlushed: Trace[] | null;
  /** Reverse index over all in-memory traces, for correlation lookups. */
  correlations: Map<string, CorrelationEntry[]>;
  /** Directory the month files live in, resolved once at creation. */
  dir: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  /** Re-entry guard: a slow flush is never overlapped by the timer. */
  flushing: boolean;
  /**
   * The standing flush failure, or null while writes succeed. `at` is when the
   * failure FIRST appeared (kept stable across retries of the same failure), so
   * the dashboard can say "failing since …". Feeds {@link getTraceStorageHealth}.
   */
  lastFlushError: TraceFlushError | null;
  /** Last overall health observed by {@link getTraceStorageHealth}; null before the first read. */
  lastHealthOk: boolean | null;
}

/** A trace write failure the operator must act on (traces buffer in RAM meanwhile). */
export interface TraceFlushError {
  monthKey: string;
  message: string;
  /** ISO instant the failure first appeared. */
  at: string;
}

function store(): TraceStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: TraceStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      open: new Map(),
      pending: new Map(),
      months: new Map(),
      loaded: new Set(),
      monthKeys: null,
      headerIndex: null,
      fullMonths: [],
      sortedFlushed: null,
      correlations: new Map(),
      dir: tracesDir(),
      flushTimer: null,
      flushing: false,
      lastFlushError: null,
      lastHealthOk: null,
    };
  }
  return g[STORE_KEY]!;
}

/** The `YYYY-MM` bucket a trace belongs to, keyed off its (UTC) start instant. */
function monthKeyOf(startedAt: string): string {
  return startedAt.slice(0, 7);
}

function fileFor(s: TraceStore, monthKey: string): string {
  return path.join(s.dir, `traces-${monthKey}.ndjson`);
}

const MONTH_FILE_RE = /^traces-(\d{4}-\d{2})\.ndjson$/;

/** Index a trace under its correlation id (if any), newest-first, de-duplicated by id. */
function indexCorrelation(s: TraceStore, trace: Trace): void {
  const corr = trace.trigger.correlationId;
  if (!corr) return;
  const list = s.correlations.get(corr) ?? [];
  if (list.some((e) => e.id === trace.id)) return;
  list.push({ id: trace.id, feature: trace.feature, startedAt: trace.startedAt });
  s.correlations.set(corr, list);
}

/** Drop a trace's correlation index entry (its month is being pruned). */
function unindexCorrelation(s: TraceStore, trace: Trace): void {
  const corr = trace.trigger.correlationId;
  if (!corr) return;
  const list = s.correlations.get(corr);
  if (!list) return;
  const rest = list.filter((e) => e.id !== trace.id);
  if (rest.length) s.correlations.set(corr, rest);
  else s.correlations.delete(corr);
}

/** Move a trace's correlation index entry when it settles with a new correlation id. */
function reindexCorrelation(s: TraceStore, trace: Trace, nextCorr: string): void {
  const prev = trace.trigger.correlationId;
  if (prev === nextCorr) return;
  if (prev) {
    const list = s.correlations.get(prev);
    if (list) {
      const rest = list.filter((e) => e.id !== trace.id);
      if (rest.length) s.correlations.set(prev, rest);
      else s.correlations.delete(prev);
    }
  }
  trace.trigger.correlationId = nextCorr;
  indexCorrelation(s, trace);
}

/** Header copy (events dropped) for list views and the header cache tier. */
function toHeader(trace: Trace): Trace {
  return { ...trace, events: [] };
}

/** Mark a full month as most-recently-used. */
function touchFullMonth(s: TraceStore, monthKey: string): void {
  const i = s.fullMonths.indexOf(monthKey);
  if (i !== -1) s.fullMonths.splice(i, 1);
  s.fullMonths.push(monthKey);
}

/** Demote least-recently-used full months back to headers (events dropped). */
function evictFullMonths(s: TraceStore): void {
  while (s.fullMonths.length > MAX_FULL_MONTHS) {
    const key = s.fullMonths.shift()!;
    const list = s.months.get(key);
    if (list) s.months.set(key, list.map(toHeader));
    // The sorted view references the replaced objects and would pin them.
    s.sortedFlushed = null;
  }
}

/** What a read needs from a month: just its headers, or the events too. */
type MonthTier = "headers" | "full";

/**
 * Parse one NDJSON month file into the cache at the requested tier, tolerating a
 * torn final line from a crash. A month already cached at (or above) the tier is
 * a no-op; asking for `full` on a header-cached month re-reads the file.
 */
async function loadMonth(s: TraceStore, monthKey: string, tier: MonthTier): Promise<void> {
  const isFull = s.fullMonths.includes(monthKey);
  if (tier === "headers" ? s.loaded.has(monthKey) : isFull) {
    if (tier === "full") touchFullMonth(s, monthKey);
    return;
  }

  let text: string;
  try {
    text = await readFile(fileFor(s, monthKey), "utf8");
  } catch {
    // Missing file — nothing flushed for this month yet. An empty month
    // satisfies both tiers (there are no events to hold or evict).
    s.months.set(monthKey, []);
    s.loaded.add(monthKey);
    if (tier === "full") touchFullMonth(s, monthKey);
    s.sortedFlushed = null;
    return;
  }

  const traces: Trace[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const trace = JSON.parse(trimmed) as Trace;
      traces.push(trace);
      indexCorrelation(s, trace);
    } catch {
      // Skip a corrupt/partial line rather than fail the whole read.
    }
  }

  if (tier === "full") {
    s.months.set(monthKey, traces);
    touchFullMonth(s, monthKey);
    evictFullMonths(s);
  } else {
    // Headers only — the parsed events are dropped so the heap does not grow
    // with history (full bodies are re-read from the file when needed).
    s.months.set(monthKey, traces.map(toHeader));
  }
  s.loaded.add(monthKey);
  s.sortedFlushed = null;
}

/**
 * The month keys present on disk, ascending. Cached after the first read (see
 * {@link TraceStore.monthKeys}); a missing directory is deliberately NOT cached,
 * so the first flush after boot is still discovered.
 */
async function diskMonthKeys(s: TraceStore): Promise<string[]> {
  if (s.monthKeys) return s.monthKeys;
  let entries: string[];
  try {
    entries = await readdir(s.dir);
  } catch {
    return []; // Directory not created yet — nothing flushed.
  }
  const keys: string[] = [];
  for (const name of entries) {
    const match = MONTH_FILE_RE.exec(name);
    if (match) keys.push(match[1]);
  }
  keys.sort();
  s.monthKeys = keys;
  return keys;
}

/** Record a month key this process just created, so no re-`readdir` is needed. */
function noteMonthKey(s: TraceStore, monthKey: string): void {
  if (!s.monthKeys || s.monthKeys.includes(monthKey)) return;
  s.monthKeys = [...s.monthKeys, monthKey].sort();
}

/** Load every month file present on disk at the given tier. */
async function ensureAllLoaded(s: TraceStore, tier: MonthTier): Promise<void> {
  for (const key of await diskMonthKeys(s)) await loadMonth(s, key, tier);
}

/**
 * The header index every full-history read needs, built at most once and shared
 * by concurrent readers. Before this existed, each Debug request re-walked every
 * month file itself — the dominant cost of loading the page on an installation
 * with real history.
 */
function ensureHeaderIndex(s: TraceStore): Promise<void> {
  if (!s.headerIndex) {
    s.headerIndex = ensureAllLoaded(s, "headers").catch((err: unknown) => {
      s.headerIndex = null; // Transient IO failure — let the next read retry.
      throw err;
    });
  }
  return s.headerIndex;
}

/**
 * Start building the header index without waiting for it — called at boot so the
 * first Debug visit does not pay for the scan, while the bot still comes online
 * on time. A read arriving mid-build awaits the same promise rather than racing
 * a second scan.
 */
export function warmTraceIndex(): void {
  void ensureHeaderIndex(store()).catch((err: unknown) => {
    console.error("Trace header index could not be built:", err);
  });
}

/** Every flushed trace currently cached, across all loaded months. */
function flushedTraces(s: TraceStore): Trace[] {
  const out: Trace[] = [];
  // A plain loop — spreading a very large month into `push(...)` can blow the
  // argument limit (`RangeError: Maximum call stack size exceeded`).
  for (const list of s.months.values()) {
    for (const trace of list) out.push(trace);
  }
  return out;
}

/** The month keys with flushed trace files, ascending — the prune picker's source. */
export async function listTraceMonths(): Promise<string[]> {
  return diskMonthKeys(store());
}

export interface PruneTracesResult {
  /** The month keys whose files were deleted, ascending. */
  months: string[];
  /** How many stored traces those files held. */
  traces: number;
}

/**
 * Delete every flushed month file strictly older than `beforeMonth` (`YYYY-MM`),
 * along with its cache tiers and correlation-index entries. Open and pending
 * traces are never touched (they are not on disk). Idempotent: a re-run after a
 * partial failure deletes whatever is still there.
 *
 * Manual-only by user decision (2026-07-20): there is no automatic retention —
 * trace data is deleted exclusively through this explicit operator action.
 */
export async function pruneTracesBefore(beforeMonth: string): Promise<PruneTracesResult> {
  const s = store();
  const keys = (await diskMonthKeys(s)).filter((key) => key < beforeMonth);
  const months: string[] = [];
  let traces = 0;
  for (const key of keys) {
    // Load headers first so the count and the correlation entries to drop are known.
    await loadMonth(s, key, "headers");
    const list = s.months.get(key) ?? [];
    await rm(fileFor(s, key), { force: true });
    traces += list.length;
    for (const trace of list) unindexCorrelation(s, trace);
    s.months.delete(key);
    s.loaded.delete(key);
    const fullIdx = s.fullMonths.indexOf(key);
    if (fullIdx !== -1) s.fullMonths.splice(fullIdx, 1);
    months.push(key);
  }
  if (months.length > 0) {
    s.sortedFlushed = null;
    s.monthKeys = null; // Files are gone; re-read the directory rather than guess.
  }
  return { months, traces };
}

// --- Write ops (called by the recorder) --------------------------------------

export interface CreateTraceInput {
  id: string;
  feature: string;
  action: string;
  /** The assistant this action belongs to, when it belongs to one. */
  assistantId?: string;
  trigger: TraceTrigger;
  startedAt: string;
  inputSummary?: string;
}

/** Open a new running trace in memory. */
export function createTrace(input: CreateTraceInput): void {
  const s = store();
  const trace: Trace = {
    id: input.id,
    feature: input.feature,
    action: input.action,
    assistantId: input.assistantId,
    status: "running",
    trigger: { ...input.trigger },
    startedAt: input.startedAt,
    finishedAt: null,
    inputSummary: input.inputSummary,
    error: null,
    events: [],
  };
  s.open.set(trace.id, trace);
  indexCorrelation(s, trace);
}

/** Append an ordered event to an open trace. */
export function appendTraceEvent(traceId: string, event: TraceEvent): void {
  const trace = store().open.get(traceId);
  if (trace) trace.events.push(event);
}

/**
 * Replace an open trace's input summary. For flows whose real input is only
 * known mid-flight — a voice reply's input is the transcript, which exists only
 * after the transcription events already recorded on the trace. No-op once
 * settled.
 */
export function setTraceInputSummary(traceId: string, inputSummary: string): void {
  const trace = store().open.get(traceId);
  if (trace) trace.inputSummary = inputSummary;
}

/**
 * Merge related row ids into an open trace, deduplicated per table. Mid-flight
 * counterpart to settling with `relatedIds`: a flow tags the rows it is about as
 * soon as it knows them, so the association survives *any* settle path — a task
 * fire that fails must still be findable by its task id.
 */
export function addTraceRelatedIds(traceId: string, key: string, ids: string[]): void {
  if (ids.length === 0) return;
  const trace = store().open.get(traceId);
  if (!trace) return;
  const merged = [...new Set([...(trace.relatedIds?.[key] ?? []), ...ids])];
  trace.relatedIds = { ...trace.relatedIds, [key]: merged };
}

export interface SettleTraceInput {
  status: Extract<TraceStatus, "success" | "error" | "skipped">;
  finishedAt: string;
  outputSummary?: string;
  error?: Trace["error"];
  /** Merged (per table, deduplicated) with ids already added mid-flight. */
  relatedIds?: Record<string, string[]>;
  /** Replaces the correlation the trace opened with; see `recorder.ts`. */
  correlationId?: string;
}

/** Settle an open trace and move it to the pending-flush buffer. */
export function settleTrace(traceId: string, input: SettleTraceInput): void {
  const s = store();
  const trace = s.open.get(traceId);
  if (!trace) return;
  trace.status = input.status;
  trace.finishedAt = input.finishedAt;
  trace.error = input.error ?? null;
  if (input.outputSummary !== undefined) trace.outputSummary = input.outputSummary;
  if (input.relatedIds !== undefined) {
    for (const [key, ids] of Object.entries(input.relatedIds)) {
      addTraceRelatedIds(traceId, key, ids);
    }
  }
  if (input.correlationId !== undefined) reindexCorrelation(s, trace, input.correlationId);
  s.open.delete(traceId);
  s.pending.set(traceId, trace);
}

// --- Flush + lifecycle -------------------------------------------------------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record the outcome of a flush pass. The failure's `at` survives retries of the
 * same failure (so the UI reports "failing since" its first occurrence, not the
 * last tick), and any ok↔failing transition is published on the `status` topic
 * so the dashboard banner appears/clears live instead of waiting for a visit.
 */
function setFlushFailure(s: TraceStore, failure: TraceFlushError | null): void {
  const was = s.lastFlushError;
  if (
    was &&
    failure &&
    was.monthKey === failure.monthKey &&
    was.message === failure.message
  ) {
    return; // Same standing failure — keep the original "failing since" instant.
  }
  if (!was && !failure) return;
  s.lastFlushError = failure;
  publishEvent("status", { feature: "traces" });
}

/**
 * Append every pending (settled) trace to its month file and mirror it into the
 * month cache. Grouped by the trace's start month, so a trace that settles after
 * midnight on the 1st still lands in the previous month's file. A group whose
 * write fails stays pending and is retried next tick — and the failure is
 * surfaced (store health + `status` event), never only logged: an unwritable
 * volume otherwise loses every buffered trace on the next restart with no
 * warning anywhere.
 */
export async function flushTracesNow(): Promise<void> {
  const s = store();
  if (s.flushing) return;
  if (s.pending.size === 0) return;
  s.flushing = true;
  try {
    const byMonth = new Map<string, Trace[]>();
    for (const trace of s.pending.values()) {
      const key = monthKeyOf(trace.startedAt);
      const group = byMonth.get(key);
      if (group) group.push(trace);
      else byMonth.set(key, [trace]);
    }

    let failure: TraceFlushError | null = null;
    try {
      await mkdir(s.dir, { recursive: true });
    } catch (err) {
      // No directory means no group below can write; report once and keep
      // everything pending. Must not throw — the timer call is un-awaited.
      console.error(`Trace flush failed creating ${s.dir}:`, err);
      setFlushFailure(s, {
        monthKey: monthKeyOf(new Date().toISOString()),
        message: errText(err),
        at: new Date().toISOString(),
      });
      return;
    }
    for (const [monthKey, traces] of byMonth) {
      // Load the month at the FULL tier first: the flushed traces carry events,
      // so appending them to a header-tier list would leave it mixed.
      await loadMonth(s, monthKey, "full");
      const data = traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
      try {
        await appendFile(fileFor(s, monthKey), data);
      } catch (err) {
        console.error(`Trace flush failed for ${monthKey}:`, err);
        failure = { monthKey, message: errText(err), at: new Date().toISOString() };
        continue; // Leave this group pending; retry next tick.
      }
      noteMonthKey(s, monthKey);
      const list = s.months.get(monthKey)!;
      for (const trace of traces) {
        list.push(trace);
        s.pending.delete(trace.id);
      }
      s.sortedFlushed = null;
    }
    setFlushFailure(s, failure);
  } finally {
    s.flushing = false;
  }
}

/** Operator-facing health of the trace write path — see {@link getTraceStorageHealth}. */
export interface TraceStorageHealth {
  ok: boolean;
  /** The traces directory when ok; the failure message when not. */
  detail: string;
  /** Settled traces held only in RAM awaiting a successful flush (lost on restart). */
  pendingCount: number;
  /** The standing flush failure, with when it first appeared. */
  lastFlushError: TraceFlushError | null;
}

/**
 * Probe the REAL write path — open the current month's file for append, exactly
 * the operation the flusher performs — and combine it with the standing flush
 * state. Never an env-presence guess: a bind mount the container user cannot
 * write to passes every "is it configured" check and still loses data.
 *
 * If the probe succeeds while a failure is standing (the operator just fixed
 * permissions), the pending buffer is flushed immediately so recovery is
 * reported the moment it is true, not a flush tick later.
 */
export async function getTraceStorageHealth(): Promise<TraceStorageHealth> {
  const s = store();
  let probeError: string | null = null;
  const probedMonth = monthKeyOf(new Date().toISOString());
  try {
    await mkdir(s.dir, { recursive: true });
    // A zero-byte append: opens the real file with the real flags (surfacing
    // EACCES/EPERM/read-only exactly like a flush) without altering content.
    await appendFile(fileFor(s, probedMonth), "");
    // The probe CREATES the file when the month is new, so the cached directory
    // listing has to learn about it here — otherwise a month that rolled over
    // mid-process would be missing from the prune picker until the next flush.
    noteMonthKey(s, probedMonth);
  } catch (err) {
    probeError = errText(err);
  }
  if (!probeError && s.lastFlushError) await flushTracesNow();

  const failure = s.lastFlushError;
  const ok = !probeError && !failure;
  // A probe-observed transition (e.g. broken-at-boot volume fixed before any
  // flush ran) must also reach live dashboards, not only flush transitions.
  // Converges: the refresh this triggers re-probes the SAME state and stays quiet.
  const prev = s.lastHealthOk;
  s.lastHealthOk = ok;
  if (prev !== null && prev !== ok) publishEvent("status", { feature: "traces" });
  return {
    ok,
    detail: ok ? s.dir : (failure?.message ?? probeError!),
    pendingCount: s.pending.size,
    lastFlushError: failure,
  };
}

/** Arm the periodic flush and warm the current month. Idempotent (boot / HMR). */
export async function startTraceStore(): Promise<void> {
  const s = store();
  await loadMonth(s, monthKeyOf(new Date().toISOString()), "full").catch(() => undefined);
  // Build the full header index in the background (user decision, 2026-08-14):
  // boot must not wait for a scan of every month, but the first Debug visit
  // should not have to pay for one either.
  warmTraceIndex();
  // Probe the write path at boot so an unwritable volume screams in the server
  // log immediately — not only at the first failed flush, a settled trace and
  // up to one flush interval later. The dashboard banner reads the same health.
  const health = await getTraceStorageHealth().catch(() => null);
  if (health && !health.ok) {
    console.error(
      `Trace storage is NOT writable (${health.detail}). Settled traces are buffered in memory and will be LOST on restart until this is fixed.`,
    );
  }
  if (s.flushTimer) return;
  const timer = setInterval(() => void flushTracesNow(), FLUSH_MS);
  if (typeof timer.unref === "function") timer.unref();
  s.flushTimer = timer;
}

/** Stop the flush timer after a final flush (graceful shutdown). */
export async function stopTraceStore(): Promise<void> {
  const s = store();
  if (s.flushTimer) {
    clearInterval(s.flushTimer);
    s.flushTimer = null;
  }
  await flushTracesNow();
}

/** Test-only: clear the singleton so a fresh {@link tracesDir} override takes effect. */
export function __resetTraceStoreForTests(): void {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: TraceStore };
  const existing = g[STORE_KEY];
  if (existing?.flushTimer) clearInterval(existing.flushTimer);
  delete g[STORE_KEY];
}

// --- Query ops (replacing the former Drizzle repository) ---------------------

/** Full trace with ordered events, or null if unknown. */
export async function getTrace(id: string): Promise<Trace | null> {
  const s = store();
  const live = s.open.get(id) ?? s.pending.get(id);
  if (live) return live;
  // Locate the trace via the (cheap) header tier, then load just its month full.
  await ensureHeaderIndex(s);
  let header: Trace | null = null;
  for (const list of s.months.values()) {
    const found = list.find((t) => t.id === id);
    if (found) {
      header = found;
      break;
    }
  }
  if (!header) return null;
  const monthKey = monthKeyOf(header.startedAt);
  await loadMonth(s, monthKey, "full");
  return s.months.get(monthKey)?.find((t) => t.id === id) ?? null;
}

export interface ScanTracesInput {
  /** Inclusive lower bound on `startedAt`. Omit for all history. */
  startUtc?: Date;
  /** **Exclusive** upper bound on `startedAt`. Omit for "up to now". */
  endUtc?: Date;
  /** Restrict to one feature. */
  feature?: string;
}

/**
 * Every trace **with its events** in a time range — the analytics aggregation read.
 *
 * Distinct from {@link listTraces}, which drops events for list performance, and
 * from {@link getEventsForTraces}, which needs the ids up front. Analytics has
 * neither: it wants every LLM round in a period without knowing which traces those
 * are, so it needs a scan.
 *
 * Range-aware: month files map 1:1 onto `startedAt` months, so only the months
 * the range intersects are loaded (an unbounded scan still loads everything).
 * Each month is collected as soon as it is loaded, so a range wider than the
 * full-month cache never loses events to eviction mid-scan.
 *
 * Traces are returned by reference, not copied — a scan over all history would
 * otherwise clone the entire store on every dashboard request. Callers must treat
 * the result as read-only.
 */
export async function scanTraces(input: ScanTracesInput = {}): Promise<Trace[]> {
  const s = store();
  const from = input.startUtc?.toISOString();
  const to = input.endUtc?.toISOString();
  const matches = (trace: Trace): boolean => {
    if (input.feature && trace.feature !== input.feature) return false;
    // ISO-8601 UTC strings compare lexically in chronological order, so the range
    // test needs no Date parsing per trace.
    if (from && trace.startedAt < from) return false;
    if (to && trace.startedAt >= to) return false;
    return true;
  };

  const out: Trace[] = [];
  for (const trace of s.open.values()) if (matches(trace)) out.push(trace);
  for (const trace of s.pending.values()) if (matches(trace)) out.push(trace);

  const fromMonth = from?.slice(0, 7);
  const toMonth = to?.slice(0, 7);
  for (const monthKey of await diskMonthKeys(s)) {
    if (fromMonth && monthKey < fromMonth) continue;
    if (toMonth && monthKey > toMonth) continue;
    await loadMonth(s, monthKey, "full");
    for (const trace of s.months.get(monthKey) ?? []) {
      if (matches(trace)) out.push(trace);
    }
  }
  return out;
}

export interface ListTracesInput {
  feature?: string;
  /** One assistant's actions — see `Trace.assistantId`. */
  assistantId?: string;
  /**
   * Only traces of THESE assistants (Phase 9 visibility scoping: a user
   * sees their own assistants' turns). Traces carrying no assistant id are
   * excluded — those are operator actions.
   */
  assistantIdIn?: readonly string[];
  status?: TraceStatus;
  /** Every trace of one process (a turn, a job run) — exact trigger correlation. */
  correlationId?: string;
  triggerKind?: TraceTrigger["kind"];
  /** The trigger's actor (a chat id, user id, or job name), exact match. */
  actor?: string;
  /** A row id under `relatedIds` (any table) — everything about one record. */
  relatedId?: string;
  /** A flow seed (correlation, trace, or row id) — the transitive story. See {@link collectFlowIds}. */
  flow?: string;
  limit?: number;
  offset?: number;
}

export interface ListTracesResult {
  /** Trace headers, newest first. Events are omitted for list performance. */
  traces: Trace[];
  total: number;
}

const newestFirst = (a: Trace, b: Trace): number => b.startedAt.localeCompare(a.startedAt);

/** Merge two newest-first arrays into one (stable across the pair). */
function mergeNewestFirst(a: Trace[], b: Trace[]): Trace[] {
  const out: Trace[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(newestFirst(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/** Bounds on a flow walk, so one over-connected id cannot pull in the whole store. */
const MAX_FLOW_DEPTH = 6;
const MAX_FLOW_TRACES = 300;

/**
 * The link ids one trace contributes to a flow walk: the process it belongs to
 * (`trigger.correlationId`), the records it touched (`relatedIds`, any table),
 * and its own id (so a bare trace id is a valid seed even where the trace
 * correlates to something else).
 */
function flowKeysOf(trace: Trace): string[] {
  const keys = [trace.id];
  if (trace.trigger.correlationId) keys.push(trace.trigger.correlationId);
  for (const ids of Object.values(trace.relatedIds ?? {})) keys.push(...ids);
  return keys;
}

/**
 * Every trace transitively linked to `seed` — the "whole story" read behind the
 * Debug `flow` filter (operator requirement, 2026-08-18: clicking a trace's
 * correlation must surface the entire process, not one slice of it).
 *
 * Traces link two ways: a shared `trigger.correlationId` groups the traces of
 * one process (a turn and its tool calls), and a shared related row id groups
 * the processes that touched one record (a task's create, updates, and every
 * fire). Neither alone tells the story — "remind me tomorrow" spans a reply
 * turn, a `tasks` create, a later fire, and the message that fire sent — so the
 * walk alternates: collect traces matching the frontier ids, widen the frontier
 * with every collected trace's own link ids, repeat. Depth- and size-capped: a
 * legacy over-broad correlation (a bare chat id) stops costing at the caps
 * instead of dragging in a chat's whole history.
 */
function collectFlowIds(all: Trace[], seed: string): Set<string> {
  // One pass to index every link key → traces carrying it.
  const byKey = new Map<string, Trace[]>();
  for (const trace of all) {
    for (const key of flowKeysOf(trace)) {
      const list = byKey.get(key);
      if (list) list.push(trace);
      else byKey.set(key, [trace]);
    }
  }

  const collected = new Set<string>();
  const seenKeys = new Set<string>([seed]);
  let frontier = [seed];
  for (let depth = 0; depth < MAX_FLOW_DEPTH && frontier.length > 0; depth++) {
    const nextKeys: string[] = [];
    for (const key of frontier) {
      for (const trace of byKey.get(key) ?? []) {
        if (collected.has(trace.id)) continue;
        if (collected.size >= MAX_FLOW_TRACES) return collected;
        collected.add(trace.id);
        for (const linked of flowKeysOf(trace)) {
          if (!seenKeys.has(linked)) {
            seenKeys.add(linked);
            nextKeys.push(linked);
          }
        }
      }
    }
    frontier = nextKeys;
  }
  return collected;
}

/**
 * List trace headers (without events), newest first, with total count.
 * Full-history read, served from the header tier; the sorted flushed view is
 * cached until the store changes rather than re-sorted on every poll.
 */
export async function listTraces(input: ListTracesInput = {}): Promise<ListTracesResult> {
  const s = store();
  await ensureHeaderIndex(s);
  if (!s.sortedFlushed) {
    s.sortedFlushed = flushedTraces(s).sort(newestFirst);
  }
  const live = [...s.open.values(), ...s.pending.values()].sort(newestFirst);
  let all = mergeNewestFirst(live, s.sortedFlushed);
  if (input.flow) {
    const ids = collectFlowIds(all, input.flow);
    all = all.filter((t) => ids.has(t.id));
  }
  if (input.feature) all = all.filter((t) => t.feature === input.feature);
  if (input.assistantId) all = all.filter((t) => t.assistantId === input.assistantId);
  if (input.assistantIdIn) {
    const allowed = new Set(input.assistantIdIn);
    all = all.filter((t) => t.assistantId != null && allowed.has(t.assistantId));
  }
  if (input.status) all = all.filter((t) => t.status === input.status);
  if (input.correlationId) {
    all = all.filter((t) => t.trigger.correlationId === input.correlationId);
  }
  if (input.triggerKind) all = all.filter((t) => t.trigger.kind === input.triggerKind);
  if (input.actor) all = all.filter((t) => t.trigger.actor === input.actor);
  if (input.relatedId) {
    const id = input.relatedId;
    // Across all tables: ids are unique enough (UUIDs, snowflake ids) that
    // scoping by table would only make the URL longer, never the match tighter.
    all = all.filter(
      (t) => t.relatedIds && Object.values(t.relatedIds).some((ids) => ids.includes(id)),
    );
  }

  const total = all.length;
  const offset = Math.max(input.offset ?? 0, 0);
  const page = input.limit !== undefined ? all.slice(offset, offset + Math.max(input.limit, 1)) : all;
  return { traces: page.map(toHeader), total };
}

/** Distinct feature names that have recorded traces, alphabetically. Full-history read. */
export async function listFeatures(): Promise<string[]> {
  const s = store();
  await ensureHeaderIndex(s);
  const names = new Set<string>();
  for (const t of s.open.values()) names.add(t.feature);
  for (const t of s.pending.values()) names.add(t.feature);
  for (const t of flushedTraces(s)) names.add(t.feature);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Ordered events for many traces, grouped by trace id (bundle export). */
export async function getEventsForTraces(ids: string[]): Promise<Map<string, TraceEvent[]>> {
  const grouped = new Map<string, TraceEvent[]>();
  if (ids.length === 0) return grouped;
  const wanted = new Set(ids);
  const s = store();
  for (const trace of s.open.values()) {
    if (wanted.has(trace.id)) grouped.set(trace.id, trace.events);
  }
  for (const trace of s.pending.values()) {
    if (wanted.has(trace.id)) grouped.set(trace.id, trace.events);
  }
  // Locate the rest via headers, then load their months full one at a time —
  // collecting each month's events before the next load can evict it.
  await ensureHeaderIndex(s);
  const monthsNeeded = new Map<string, Set<string>>();
  for (const list of s.months.values()) {
    for (const trace of list) {
      if (!wanted.has(trace.id) || grouped.has(trace.id)) continue;
      const key = monthKeyOf(trace.startedAt);
      const set = monthsNeeded.get(key) ?? new Set<string>();
      set.add(trace.id);
      monthsNeeded.set(key, set);
    }
  }
  for (const [monthKey, idSet] of monthsNeeded) {
    await loadMonth(s, monthKey, "full");
    for (const trace of s.months.get(monthKey) ?? []) {
      if (idSet.has(trace.id)) grouped.set(trace.id, trace.events);
    }
  }
  return grouped;
}

/**
 * Latest trace id for each correlation id, newest per id. Served from the
 * in-memory correlation index (fast — the reply/history hot path), covering all
 * currently-loaded traces (current month is warmed at boot; visiting Debug loads
 * the rest). A correlation for a very old, unloaded message resolves to nothing,
 * which callers tolerate (`traceId` is optional → no drill-down link).
 *
 * Pass `features` to pick a *particular* kind of action when several features key
 * a trace on the same message.
 */
export async function getLatestTraceIdsByCorrelation(
  correlationIds: string[],
  options: { features?: string[] } = {},
): Promise<Map<string, string>> {
  const s = store();
  const result = new Map<string, string>();
  const unique = [...new Set(correlationIds.filter(Boolean))];
  const featureFilter = options.features?.length ? new Set(options.features) : null;

  for (const corr of unique) {
    const entries = s.correlations.get(corr);
    if (!entries?.length) continue;
    const candidates = featureFilter
      ? entries.filter((e) => featureFilter.has(e.feature))
      : entries;
    if (!candidates.length) continue;
    // Newest wins; on an equal start instant the later-recorded entry wins (the
    // index is in creation order), so the tie-break is deterministic.
    const newest = candidates.reduce((a, b) =>
      b.startedAt.localeCompare(a.startedAt) >= 0 ? b : a,
    );
    result.set(corr, newest.id);
  }
  return result;
}

/**
 * The newest trace whose correlation is a message's — either the message's own
 * correlation or one of the per-assistant turn correlations under it
 * (`turnCorrelationId` appends the assistant, so one message in a shared chat
 * has one correlation per assistant that answered it).
 *
 * Scans the index rather than reading one key, because the assistant half is
 * exactly what a caller looking a message up does not know. The index is small
 * (one entry per correlation of the loaded months) and this runs on the
 * feedback path, not per message.
 */
export async function getLatestTraceIdForMessage(
  messageCorrelationId: string,
  options: { features?: string[] } = {},
): Promise<string | null> {
  const s = store();
  const featureFilter = options.features?.length ? new Set(options.features) : null;
  const prefix = `${messageCorrelationId}:`;
  let newest: CorrelationEntry | null = null;
  for (const [corr, entries] of s.correlations) {
    if (corr !== messageCorrelationId && !corr.startsWith(prefix)) continue;
    for (const entry of entries) {
      if (featureFilter && !featureFilter.has(entry.feature)) continue;
      if (!newest || entry.startedAt.localeCompare(newest.startedAt) >= 0) newest = entry;
    }
  }
  return newest?.id ?? null;
}
