import { z } from "zod";

/**
 * Shared trace contract.
 *
 * Every feature records its meaningful actions as a `Trace` with ordered
 * `TraceEvent`s. This is the single schema behind every Debug page, the JSON
 * log/trace download bundle, and the dashboard status feeds. Feature code must
 * not invent its own trace shape — add event types here instead.
 *
 * These are pure types/schemas (no DB, no secrets) so they can be imported by
 * both server recording code and client debug UI. The server-only recorder and
 * persistence live under `server/trace`.
 */

/**
 * Rows per page on the Debug trace list. Lives here (not with the server
 * service) because both halves need it: the Server Component picks the page to
 * fetch, and the shared explorer UI sizes its pagination from the same number.
 */
export const DEFAULT_TRACE_PAGE_SIZE = 50;

/** Terminal + in-flight states shared by traces and background jobs. */
export const traceStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
  "skipped",
]);
export type TraceStatus = z.infer<typeof traceStatusSchema>;

/** Severity/outcome for an individual event line. */
export const traceLevelSchema = z.enum(["debug", "info", "success", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

/**
 * Kind of step recorded within a trace. Kept as an open-ended string union so
 * features can record domain steps, but the common cross-cutting kinds are
 * enumerated for consistent debug rendering.
 */
export const traceEventTypeSchema = z.enum([
  "step", // generic decision/step
  "input", // input received / parsed
  "output", // output produced
  "external_call", // outbound HTTP / API / tool call
  "llm_request", // LLM request metadata
  "llm_response", // LLM response + usage
  "db", // database read/write of interest
  "error", // recorded failure
]);
export type TraceEventType = z.infer<typeof traceEventTypeSchema>;

/**
 * What or who triggered a traced action. One kind per way in: a message from
 * a source app names that source (`telegram`, `chat`), so Debug can filter a
 * web-thread turn apart from an operator pressing a dashboard button.
 */
export const traceTriggerSchema = z.object({
  kind: z.enum(["telegram", "chat", "dashboard", "cron", "system", "api", "test"]),
  /** Human-readable actor, e.g. chat id, user, job name. */
  actor: z.string().optional(),
  /** Correlation id linking related traces (e.g. a Telegram update id). */
  correlationId: z.string().optional(),
});
export type TraceTrigger = z.infer<typeof traceTriggerSchema>;

/**
 * Filterable trace facets, as they appear in `/debug` URLs. The one vocabulary
 * shared by the Debug page's query parsing, the filter controls, and every
 * clickable facet on a trace (feature, status, trigger, correlation) — so a
 * click, a typed URL, and a dropdown can never drift apart.
 */
export interface TraceFilterParams {
  feature?: string;
  /** One assistant's actions — see `Trace.assistantId`. */
  assistantId?: string;
  status?: TraceStatus;
  correlationId?: string;
  triggerKind?: TraceTrigger["kind"];
  actor?: string;
  /** A row id under `trace.relatedIds` (any table) — everything about one record. */
  relatedId?: string;
  /**
   * A flow seed — any correlation id, trace id, or related row id. Unlike the
   * exact `correlationId` filter (one process) this follows the links
   * *transitively*: correlations connect the traces of one turn, related row
   * ids connect the turns that touched the same record, and the flow walk
   * alternates between the two until the whole story is collected — the reply
   * that created a task, its tool calls, every fire of that task, and what each
   * fire sent, from one click.
   */
  flow?: string;
  offset?: number;
}

/** Canonical Debug-list URL for a filter set — every clickable trace facet builds here. */
export function debugFilterHref(params: TraceFilterParams, basePath = "/debug"): string {
  const search = new URLSearchParams();
  if (params.feature) search.set("feature", params.feature);
  if (params.assistantId) search.set("assistantId", params.assistantId);
  if (params.status) search.set("status", params.status);
  if (params.correlationId) search.set("correlationId", params.correlationId);
  if (params.triggerKind) search.set("triggerKind", params.triggerKind);
  if (params.actor) search.set("actor", params.actor);
  if (params.relatedId) search.set("relatedId", params.relatedId);
  if (params.flow) search.set("flow", params.flow);
  if (params.offset) search.set("offset", String(params.offset));
  const qs = search.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Correlation id for one background-job run, shared by every trace that run
 * opens — the nightly memory sweep stamps it on each chat-day extraction, the
 * vision backfill on each described media — so `/debug?correlationId=…` shows
 * a whole run start to end. Readable on purpose (job + start time): an operator
 * seeing it on a trace can tell *which* run without a lookup. A trace opened
 * with no correlation at all self-correlates instead (see `startTrace`).
 */
export function newRunCorrelationId(job: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${job}:${stamp}`;
}

/** Token usage for LLM-related events. */
export const llmUsageSchema = z.object({
  /**
   * The model **requested** — the id configured in Settings. A call's stable
   * identity, and what every `model` column and the analytics group by.
   */
  model: z.string().optional(),
  /**
   * What the provider reported serving, when it differs from {@link model}.
   *
   * Recorded because a provider may resolve a tag to something else: Docker Model
   * Runner answers `docker.io/ai/gemma4:26B` with the bundle path of the file it
   * loaded (`/models/bundles/sha256/<digest>/model/….gguf` — the digest being the
   * model id, so it is the same model). Kept out of `model` so that resolution
   * cannot fragment a model's stats, and kept at all so a provider serving the
   * *wrong* thing is still visible in Debug.
   */
  servedModel: z.string().optional(),
  /**
   * What this call was *for* — see `features/analytics/llm-call-kind.ts`.
   *
   * Recorded at the call site rather than derived from the trace's feature/action,
   * because one traced action can contain several unlike calls: handling a message
   * is an addressing check, then N tool rounds, then a final answer. Analytics
   * groups on this, so a slow tool turn is visible instead of being averaged into
   * the reply it belonged to.
   */
  callKind: z.string().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

/** One ordered step within a trace. */
export const traceEventSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  /** Monotonic order within the trace, starting at 0. */
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  type: traceEventTypeSchema,
  level: traceLevelSchema.default("info"),
  message: z.string(),
  /** Structured, client-safe payload for this event. */
  data: z.unknown().optional(),
  usage: llmUsageSchema.optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

/** A single meaningful action, e.g. handling one Telegram message. */
export const traceSchema = z.object({
  id: z.string(),
  feature: z.string(),
  action: z.string(),
  /**
   * The assistant this action belonged to, when it belonged to one: a reply
   * turn, a timed task fire, an inbound message on that assistant's bot, an
   * edit to the assistant itself. Absent on everything that is nobody's in
   * particular (background jobs, settings, auth). Recorded so Debug can show
   * *whose* action a row was and filter to one assistant.
   */
  assistantId: z.string().optional(),
  status: traceStatusSchema,
  trigger: traceTriggerSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
  /** Short human summary of the input. */
  inputSummary: z.string().optional(),
  /** Short human summary of the output. */
  outputSummary: z.string().optional(),
  /** Client-safe error summary when status is `error`. */
  error: z
    .object({ code: z.string().optional(), message: z.string() })
    .nullable()
    .default(null),
  /** Related database row ids by table, for operator drill-down. */
  relatedIds: z.record(z.string(), z.array(z.string())).optional(),
  events: z.array(traceEventSchema).default([]),
});
export type Trace = z.infer<typeof traceSchema>;

/** Downloadable log/trace bundle format shared by every feature's Debug page. */
export const traceBundleSchema = z.object({
  schema: z.literal("llm-tg-bot/trace-bundle@1"),
  exportedAt: z.string().datetime(),
  traces: z.array(traceSchema),
});
export type TraceBundle = z.infer<typeof traceBundleSchema>;
