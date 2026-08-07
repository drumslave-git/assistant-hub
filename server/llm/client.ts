import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";

import { APICallError } from "ai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { ApiError } from "@/lib/api-error";
import type { LlmBackendId } from "@/lib/llm-backend";

import { adapterFor } from "./backends";
import type { ReasoningMode } from "./backends";
import { withLlmPriority, type LlmPriority } from "./priority";
import { completeRound } from "./transport";

export type { LlmPriority } from "./priority";

/**
 * Shared client for OpenAI-compatible LLM endpoints. Server-only. The connection
 * (base URL + optional API key) is passed in explicitly — it comes from DB-backed
 * settings, not env vars — so the same client serves the settings "test
 * connection" probe and, later, the conversation core.
 */

export interface LlmConnection {
  baseUrl: string;
  apiKey?: string | null;
  /**
   * Which inference server answers at {@link baseUrl} — see
   * `@/lib/llm-backend` and `./backends`.
   *
   * A property of the *host*, exactly like {@link apiKey}: when a feature falls
   * back to the LLM endpoint because it has none of its own, it inherits that
   * endpoint's backend along with its key. Omitted resolves to the conservative
   * generic adapter, so a connection assembled without one behaves as it did
   * before this existed.
   */
  backend?: LlmBackendId | null;
}

const LIST_MODELS_TIMEOUT_MS = 15_000;
/**
 * Default wire timeout for interactive completions — in practice the
 * *classification* deadline, since the reply path overrides it with its own
 * (`REPLY_COMPLETION_TIMEOUT_MS`, sized from a much longer tail).
 *
 * Sized from measured production traces rather than a round number: the
 * addressing analyzer and rule matcher run on a ~500-token prompt with a
 * 3,000-token thinking cap, and over the retained window their median sat at
 * 15–25s with a 57.7s worst case — so 90s is ~1.5× the slowest ever seen. It
 * was 120s for everything, which only meant a *hung* request held a person's
 * turn hostage for two minutes before failing (incident 2026-08-03, trace
 * `82a8976c…`: the request died at exactly 120.005s while the endpoint answered
 * the next call 0.2s later). A tight deadline plus
 * {@link INTERACTIVE_RETRY_ATTEMPTS} recovers from that faster than a long one
 * waits — but only where the deadline still clears the honest work, which is
 * why the reply does not share this number.
 */
export const CHAT_COMPLETION_TIMEOUT_MS = 90_000;

/**
 * Wire timeout for one **reply** round, passed explicitly by the Telegram
 * pipeline in place of {@link CHAT_COMPLETION_TIMEOUT_MS}.
 *
 * A reply and a classification are not the same call, and one deadline over both
 * has to be the reply's. Measured over 118 successful reply rounds on the live
 * bot (2026-08-03): median 18.9s, p95 68.3s, **max 95.8s** — against a 57.7s
 * worst case for the classifications. The shared 90s therefore sat *under* the
 * reply tail, which is incident trace `93a963ec…`: both attempts cut at exactly
 * 90.0s on a round that was working, just slowly.
 *
 * {@link INTERACTIVE_RETRY_ATTEMPTS} is what covers a *hung* request, and covers
 * it well — a turn earlier the same day recovered two hung rounds and delivered
 * its video. It cannot cover this: a round that genuinely needs 95s needs 95s on
 * the second attempt too. So with the retry in place the deadline is sized for
 * the slow case rather than the hung one — ~1.6× the slowest legitimate round on
 * record — while classifications keep the tighter default and still fail over
 * fast.
 */
export const REPLY_CHAT_COMPLETION_TIMEOUT_MS = 150_000;

/**
 * Wire timeout for background-priority completions. Background requests only
 * dispatch when the endpoint is quiet (see `priority.ts`), so this bounds real
 * processing time — and a summarize/extract batch over a long transcript
 * legitimately outlives the interactive 120s on a local model.
 */
export const BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS = 300_000;

/**
 * A single content part of a multimodal message. Only `user` turns carry image
 * or audio parts (an image as a data: URL with base64 JPEG; audio as base64
 * WAV/MP3 for an audio-capable chat model); text parts and plain string content
 * behave identically to a text-only turn.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

/** A single chat turn sent to the model. Content is plain text, or — for a
 * vision turn — an array of text/image parts. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

/** Normalized token usage for a completion, when the provider reports it. */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Result of a chat completion: the assistant text plus metadata for tracing. */
export interface ChatCompletionResult {
  content: string;
  /**
   * The model **we asked for** — the id configured in Settings. This is a call's
   * stable identity: it is what the operator chose, it does not change with the
   * provider's mood, and it is the only name that matches the dashboard.
   *
   * Deliberately *not* the provider's answer. Docker Model Runner resolves a tag to
   * the artifact it loaded and reports that instead — `docker.io/ai/gemma4:26B`
   * comes back as `/models/bundles/sha256/<digest>/model/…​.gguf`. Recording that as
   * the identity made one configured model appear as two, split by which code path
   * happened to run. See {@link servedModel} for the provider's answer, which is
   * kept rather than discarded.
   */
  model: string;
  /**
   * What the provider said it actually served, verbatim, when it said anything.
   *
   * Worth keeping separately: if this stops matching {@link model}, the endpoint is
   * serving something other than what was configured — which is real information,
   * and the reason this isn't simply thrown away.
   */
  servedModel?: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Exact request payload sent to the endpoint (for Debug bodies). */
  requestBody: unknown;
  /** Raw response object returned by the endpoint (for Debug bodies). */
  responseBody: unknown;
}

/**
 * Replace inline image bytes in a message list with a compact marker for trace
 * recording. A vision turn carries a `data:image/...;base64,<~1MB>` URL per
 * image; storing that verbatim in a trace would bloat the row and make the Debug
 * JSON unreadable. The bytes are not lost — the actual image is persisted in
 * `message_media` and shown on the Vision page — so here we keep everything the
 * operator reads (roles, text, structure) and swap each data URL for
 * `data:<mime>;base64,<N bytes>`. Non-image content is returned unchanged.
 */
export function sanitizeMessagesForTrace(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      if (part.type === "input_audio") {
        // Audio bytes get the same treatment as image bytes: the real audio is
        // persisted in `message_media` while pending, so the trace keeps only
        // the format and size.
        return {
          type: "input_audio" as const,
          input_audio: {
            data: `<${part.input_audio.data.length} bytes>`,
            format: part.input_audio.format,
          },
        };
      }
      if (part.type !== "image_url") return part;
      const url = part.image_url.url;
      const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
      if (!match) return part;
      const [, mime, data] = match;
      return {
        type: "image_url" as const,
        image_url: { url: `data:${mime};base64,<${data.length} bytes>` },
      };
    });
    return { ...message, content };
  });
}

/**
 * Redact a full chat-completion request body for trace recording: the exact
 * object sent to the provider (`model`, `messages`, `tools`, and any other params)
 * is preserved verbatim except that inline image bytes in `messages` are swapped
 * for a compact `data:<mime>;base64,<N bytes>` marker (see
 * {@link sanitizeMessagesForTrace}). Non-object bodies pass through unchanged.
 */
export function sanitizeRequestBodyForTrace<T>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;
  return { ...body, messages: sanitizeMessagesForTrace(messages as ChatMessage[]) };
}

/** Normalize any base URL to its OpenAI-compatible `/v1` form. */
export function toOpenAiBaseUrl(base: string): string {
  const host = base.trim().replace(/\/+$/, "");
  if (!host) throw ApiError.badRequest("LLM base URL is required");
  return host.endsWith("/v1") ? host : `${host}/v1`;
}

/**
 * Rewrite a non-OpenAI-shaped error body into the shape the SDK understands, so
 * the server's own explanation survives.
 *
 * The SDK parses an error body and keeps only its `error` key
 * (`APIError.generate`: `errorResponse?.['error']`). Every OpenAI-*compatible*
 * backend that reports errors differently — FastAPI's `{"detail": "…"}`, or a bare
 * `{"message": "…"}` — therefore arrives as the infamous **"500 status code (no
 * body)"** with the real reason discarded, because the SDK also drops the raw text
 * whenever the body parsed as JSON (`errMessage = errJSON ? undefined : errText`).
 * A *plain-text* error survives; a well-formed JSON one does not.
 *
 * This cost us a real diagnosis once: a broken image backend answered
 * `{"detail":"Image generation failed: Input type (c10::Half) and bias type
 * (float) should be the same"}` — a precise, actionable dtype error — and the
 * operator was shown "500 status code (no body)".
 *
 * A body that already carries `error` is passed through untouched, so nothing
 * changes for a real OpenAI endpoint.
 */
async function fetchWithErrorDetail(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  let body = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !("error" in parsed)) {
      // `detail` (FastAPI) and `message` are the common shapes; fall back to the
      // whole object rather than inventing a summary of something we don't know.
      const record = parsed as Record<string, unknown>;
      const message =
        typeof record.detail === "string"
          ? record.detail
          : typeof record.message === "string"
            ? record.message
            : JSON.stringify(parsed);
      body = JSON.stringify({ error: { message } });
    }
  } catch {
    // Not JSON — the SDK already surfaces a plain-text body as the message.
  }

  // The body was consumed above, so hand the SDK a fresh, readable Response.
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Construct an OpenAI SDK client for an OpenAI-compatible endpoint. */
export function createOpenAiClient(conn: LlmConnection): OpenAI {
  return new OpenAI({
    apiKey: conn.apiKey?.trim() || "not-needed",
    baseURL: toOpenAiBaseUrl(conn.baseUrl),
    maxRetries: 0,
    fetch: fetchWithErrorDetail,
  });
}

function apiErrorDetail(err: APIError): string {
  if (typeof err.error === "string") return err.error;
  // The human-readable half, when the provider gave one: both OpenAI's own shape
  // and anything normalized by `fetchWithErrorDetail` carry it here. Preferred over
  // stringifying the object, which buries the sentence that matters in braces.
  const message = (err.error as { message?: unknown } | undefined)?.message;
  if (typeof message === "string" && message.trim()) return message;
  if (err.error && Object.keys(err.error).length > 0) return JSON.stringify(err.error);
  return err.message;
}

/**
 * The most informative sentence on an AI SDK call error: the endpoint's own
 * body when it sent one, else the SDK's message. Preferred over the message
 * alone because an OpenAI-compatible server's real reason ("Image generation
 * failed: Input type (c10::Half) and bias type (float) should be the same")
 * lives in the body, and a generic status line is what replaces it otherwise.
 */
function sdkErrorDetail(err: InstanceType<typeof APICallError>): string {
  const body = err.responseBody?.trim();
  if (!body) return err.message;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = (parsed.error as { message?: unknown } | undefined)?.message;
    for (const value of [nested, parsed.detail, parsed.message]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    // Not JSON — the body is the message.
  }
  return body;
}

/**
 * True when an LLM failure means the request was too large for the model's
 * context window — the one provider error a caller can fix by sending less
 * (e.g. shrinking the injected history) rather than by retrying as-is.
 *
 * There is no structured code for this across OpenAI-compatible servers, and
 * even one server words it differently per path — llama.cpp rejects an
 * oversized prompt with `400: request (N tokens) exceeds the available context
 * size (M tokens)` but reports mid-generation exhaustion as `500: Context size
 * has been exceeded.` — so this matches the *concept*, not exact phrasings: a
 * context size/length/window mention plus an exceeded/overflow word, in either
 * order. OpenAI's own wording (`maximum context length … Please reduce …`)
 * contains no "exceeded" and is matched separately.
 */
export function isContextOverflowError(err: unknown, backend?: LlmBackendId | null): boolean {
  // The AI SDK keeps the endpoint's raw error body on the error, where the
  // OpenAI SDK discarded any JSON body that was not its own `{error:{}}` shape.
  // The sentence that names the overflow often lives only there, so both are
  // searched — see `fetchWithErrorDetail` for the failure this used to cause.
  const body = APICallError.isInstance(err) ? (err.responseBody ?? "") : "";
  const message =
    (err instanceof Error ? err.message : typeof err === "string" ? err : "") +
    (body ? `\n${body}` : "");
  if (!message.trim()) return false;
  if (/maximum context length/i.test(message)) return true; // OpenAI, vLLM
  if (
    /context[_ ](?:size|length|window)|context overflow/i.test(message) &&
    /exceed|overflow|too (?:large|long|big|many)/i.test(message)
  ) {
    return true;
  }
  // Phrasings the concept matcher cannot see, contributed by the backend the
  // operator declared — never instead of the shared matcher, only after it.
  return adapterFor(backend).contextOverflowPatterns.some((pattern) => pattern.test(message));
}

/**
 * True when an LLM failure is worth simply trying again: the request never got a
 * usable answer for a reason that has nothing to do with what we sent.
 *
 * The distinction that matters is fixable-by-retry versus fixable-by-us. A
 * timeout, a dropped connection, or a 5xx from the endpoint says nothing about
 * the request — the same bytes may well succeed a second later. A context
 * overflow, a rejected key, or a malformed request will fail identically every
 * time, and retrying those only doubles the wait before the same error.
 *
 * Named for the incident that motivated it (2026-08-03, trace `82a8976c…`): one
 * reply request hung until the wire timeout while the endpoint served the next
 * call 0.2s later, and the group got "the bot could not generate a reply"
 * because nothing anywhere retried.
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (isContextOverflowError(err)) return false;
  // Judged on the raw SDK error, before `toLlmError` flattens the interesting
  // distinctions away: that mapping sends a 400 and a dropped connection alike to
  // `service_unavailable`, and only one of those is worth a second attempt (a
  // rejected request is rejected the same way every time).
  if (err instanceof APIConnectionError) return true; // covers the timeout subclass
  if (err instanceof APIError) return err.status === undefined || err.status >= 500;
  // AI SDK transport. `isRetryable` already encodes the 408/409/429/5xx rule;
  // a call that never reached a status (connection dropped, deadline hit) has
  // none, and is the hung-request case this whole retry exists for.
  if (APICallError.isInstance(err)) {
    return err.isRetryable || err.statusCode === undefined || err.statusCode >= 500;
  }
  // A deadline that fired: the SDK surfaces `timeout` as an abort, which says
  // nothing about the request and is worth one more attempt.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  // Already mapped by a caller: the endpoint-unavailable family, and nothing
  // else — `bad_request` (401/403) is a configuration fault, not a bad moment.
  if (err instanceof ApiError) return err.code === "service_unavailable";
  return false;
}

/**
 * Attempts an interactive completion gets on the wire, the retry included. One
 * retry: it covers the hung-connection case, and a second failure means the
 * endpoint is genuinely unwell — at which point a person waiting on a chat reply
 * is better served by an honest failure than by a third deadline.
 *
 * What the retry does *not* cover, and cannot: a request that is merely slower
 * than its deadline. The second attempt restarts prefill and decode from
 * nothing, so it needs the same time the first one was denied and fails
 * identically. That case is the deadline's job — see the note on
 * `REPLY_COMPLETION_TIMEOUT_MS`, which exists because 90s once sat under the
 * reply tail and turned a working round into two clean 90s failures.
 */
export const INTERACTIVE_RETRY_ATTEMPTS = 2;

/** Pause before retrying, so a still-busy endpoint is not hit the same instant. */
export const INTERACTIVE_RETRY_DELAY_MS = 3_000;

/** Reported before a retry is dispatched, so the wait is visible on the trace. */
export interface LlmRetryInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts this call will make. */
  attempts: number;
  /** The failure being retried, already mapped by {@link toLlmError}. */
  error: string;
  delayMs: number;
}

/**
 * Run one provider call with the retry policy applied, mapping failures through
 * {@link toLlmError} either way.
 *
 * Shared by both completion paths so they cannot drift. In the tool loop it
 * wraps a single *round*, which is what makes a retry safe there: tool results
 * already gathered stay in the conversation, so a timeout after a download does
 * not re-run the download.
 *
 * Background calls are deliberately not retried — they wait for a quiet endpoint
 * already, have their own longer deadline, and run again on their own schedule.
 * Replies do not get another schedule.
 */
export async function withLlmRetry<T>(
  run: () => Promise<T>,
  options: {
    baseUrl: string;
    priority: LlmPriority;
    onRetry?: (info: LlmRetryInfo) => void | Promise<void>;
  },
): Promise<T> {
  const attempts = options.priority === "interactive" ? INTERACTIVE_RETRY_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const retryable = isRetryableLlmError(err);
      const mapped = toLlmError(err, options.baseUrl);
      if (attempt >= attempts || !retryable) throw mapped;
      await options.onRetry?.({
        attempt,
        attempts,
        error: mapped.message,
        delayMs: INTERACTIVE_RETRY_DELAY_MS,
      });
      await new Promise((resolve) => setTimeout(resolve, INTERACTIVE_RETRY_DELAY_MS));
    }
  }
}

/** Map provider/network failures to a clean {@link ApiError} without leaking internals. */
export function toLlmError(err: unknown, baseUrl: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return ApiError.serviceUnavailable(`Connection to ${baseUrl} timed out`);
  }
  if (err instanceof APIConnectionError) {
    return ApiError.serviceUnavailable(`Could not connect to ${baseUrl}: ${err.message}`);
  }
  if (err instanceof APIError) {
    // 401/403 mean the key/config is wrong (a user-fixable request error);
    // anything else from the endpoint is treated as it being unavailable.
    const code = err.status === 401 || err.status === 403 ? "bad_request" : "service_unavailable";
    return new ApiError(code, `LLM endpoint error (${err.status ?? "unknown"}): ${apiErrorDetail(err)}`);
  }
  if (APICallError.isInstance(err)) {
    // No status at all means the call never got an answer — a dropped
    // connection or a fired deadline, which is the endpoint being unreachable
    // rather than an endpoint error to quote a status for.
    if (err.statusCode === undefined) {
      return ApiError.serviceUnavailable(`Could not reach ${baseUrl}: ${err.message}`);
    }
    const code =
      err.statusCode === 401 || err.statusCode === 403 ? "bad_request" : "service_unavailable";
    // The raw body is kept by this SDK, so the server's own explanation survives
    // — it is usually the only text that says what actually went wrong.
    return new ApiError(code, `LLM endpoint error (${err.statusCode}): ${sdkErrorDetail(err)}`);
  }
  return ApiError.serviceUnavailable(err instanceof Error ? err.message : String(err));
}

/**
 * The trace `usage` payload for a completion — the one place a
 * {@link ChatCompletionResult} is turned into what gets recorded.
 *
 * Every feature used to hand-build this object identically, which is how the two
 * completion paths drifted apart without anyone noticing: each call site faithfully
 * copied `result.model`, and the *meaning* of that field silently differed
 * depending on whether tools were enabled. One builder means a call is recorded the
 * same way no matter which feature made it.
 */
export function llmUsageOf(result: {
  model: string;
  servedModel?: string;
  usage?: ChatUsage;
  latencyMs: number;
}): {
  model: string;
  servedModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
} {
  return {
    model: result.model,
    servedModel: result.servedModel,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    latencyMs: result.latencyMs,
  };
}

/**
 * The model an OpenAI-compatible response claims to have served, or `undefined`
 * when it claims nothing.
 *
 * Shared by both completion paths ({@link chatCompletion} and the tool loop) so the
 * two can never disagree about what a `ChatCompletionResult` means. They did
 * disagree: the plain path recorded the provider's answer while the tool loop
 * substituted the requested id, so enabling tools silently changed the recorded
 * model name and one model showed up as two.
 */
export function servedModelOf(responseBody: unknown): string | undefined {
  const reported = (responseBody as { model?: unknown } | null | undefined)?.model;
  return typeof reported === "string" && reported.trim() ? reported : undefined;
}

/** The completion's `finish_reason`, when the provider reported one. */
export function finishReasonOf(responseBody: unknown): string | undefined {
  const reason = (responseBody as { choices?: { finish_reason?: unknown }[] } | null | undefined)
    ?.choices?.[0]?.finish_reason;
  return typeof reason === "string" && reason ? reason : undefined;
}

/**
 * The error for a response cut off by the context window (`finish_reason:
 * "length"` with nothing usable produced). Distinct from "LLM returned an empty
 * response" because the operator's fix is opposite: sending less (or raising the
 * server's context length), not investigating the provider. Worded to satisfy
 * {@link isContextOverflowError}, so callers that already shrink-and-retry on a
 * provider-rejected oversized prompt recover from mid-generation exhaustion the
 * same way.
 */
export const CONTEXT_EXHAUSTED_MESSAGE =
  "LLM context window exceeded: generation was cut off (finish_reason \"length\") before a reply was produced";

/**
 * List distinct model ids from an OpenAI-compatible endpoint, sorted. Doubles as
 * the connection health probe: success proves the endpoint is reachable and the
 * key (if any) is accepted. `timeoutMs` bounds the wait (shorter for status
 * dashboards, longer for an explicit test).
 */
export async function listModels(
  conn: LlmConnection,
  timeoutMs: number = LIST_MODELS_TIMEOUT_MS,
): Promise<string[]> {
  try {
    const page = await createOpenAiClient(conn).models.list({ timeout: timeoutMs });
    const seen = new Set<string>();
    for (const entry of page.data ?? []) {
      const id = (entry.id ?? "").trim();
      if (id) seen.add(id);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw toLlmError(err, conn.baseUrl);
  }
}

/**
 * Generate a chat completion from an OpenAI-compatible endpoint. Returns the
 * assistant's reply text plus model/usage/latency for trace recording. Throws a
 * clean {@link ApiError} on provider/network failure, and `service_unavailable`
 * if the endpoint returns no assistant content.
 */
export async function chatCompletion(
  conn: LlmConnection,
  input: {
    model: string;
    messages: ChatMessage[];
    timeoutMs?: number;
    /**
     * Dispatch priority on the shared endpoint (see `priority.ts`). Interactive
     * (the default) goes straight out; background waits for a quiet endpoint
     * and defaults to the longer {@link BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS}.
     */
    priority?: LlmPriority;
    /**
     * Hard cap on generated tokens (thinking included, on a thinking model).
     * A runaway-generation stop, not a length target — an aggressive value cuts
     * a thinking model off before its answer, which reads as an empty response.
     */
    maxTokens?: number;
    /**
     * What to ask of a thinking model. The *intent*, not the field: which knob
     * expresses it is the backend adapter's business (`./backends`), because
     * they disagree — `reasoning_effort` is measured being ignored by Ollama,
     * which wants `think`, while llama.cpp wants a chat-template argument.
     *
     * Classification calls pass "off": their answer is a small JSON verdict, and
     * thinking was measured costing ~180 tokens to produce a 15-token answer.
     */
    reasoning?: ReasoningMode;
    /** Reports the exact request body just before it is sent (for trace recording). */
    onRequest?: (requestBody: unknown) => void | Promise<void>;
    /**
     * Reports a retryable failure just before the retry is dispatched, so a
     * caller with a trace can record that the endpoint had to be asked twice —
     * a recovered turn must not look like a clean one.
     */
    onRetry?: (info: LlmRetryInfo) => void | Promise<void>;
  },
): Promise<ChatCompletionResult> {
  const priority = input.priority ?? "interactive";
  // Reported to the trace before the call, so the response step's elapsed time
  // is provider latency. The transport reports the *actual* body the SDK built
  // afterwards, and that is what the result carries — this is the caller's
  // preview, kept in the shape the trace has always recorded.
  const requestBody = {
    model: input.model,
    messages: input.messages as ChatCompletionMessageParam[],
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...adapterFor(conn.backend).chatBodyExtras({ reasoning: input.reasoning }),
  };
  const timeout =
    input.timeoutMs ??
    (priority === "background"
      ? BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS
      : CHAT_COMPLETION_TIMEOUT_MS);
  // Only the wire is retried. The gate is inside it, so a retried attempt takes
  // its slot again from scratch rather than holding one across the pause; the
  // answer's own faults are judged after, where a retry can never reach them —
  // an empty or context-exhausted completion is what this prompt produces on this
  // model, and asking again just spends the time twice for the same result.
  const { completion, latencyMs } = await withLlmRetry(
    () =>
      // Everything below runs inside the gate so the latency and the HTTP timeout
      // measure the wire, not the in-app queue; the queue wait shows up in traces
      // as the gap before the request event.
      withLlmPriority(priority, async () => {
        await input.onRequest?.(requestBody);
        const round = await completeRound(conn, {
          model: input.model,
          messages: input.messages as ChatCompletionMessageParam[],
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.reasoning ? { reasoning: input.reasoning } : {}),
          timeoutMs: timeout,
        });
        return { completion: round, latencyMs: round.latencyMs };
      }),
    { baseUrl: conn.baseUrl, priority, onRetry: input.onRetry },
  );

  if (!completion.content) {
    throw ApiError.serviceUnavailable(
      completion.finishReason === "length"
        ? CONTEXT_EXHAUSTED_MESSAGE
        : "LLM returned an empty response",
    );
  }
  return {
    content: completion.content,
    model: input.model,
    // The provider's own answer, preferred over the SDK's echo of what we asked
    // for: a served model that stops matching the configured one is real
    // information (see `ChatCompletionResult.servedModel`).
    servedModel: servedModelOf(completion.responseBody) ?? completion.servedModel,
    usage: completion.usage,
    latencyMs,
    // The body the SDK actually built and sent, not the preview above.
    requestBody: completion.requestBody ?? requestBody,
    responseBody: completion.responseBody,
  };
}
