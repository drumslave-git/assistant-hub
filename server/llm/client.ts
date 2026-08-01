import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { ApiError } from "@/lib/api-error";
import { withLlmPriority, type LlmPriority } from "./priority";

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
}

const LIST_MODELS_TIMEOUT_MS = 15_000;
export const CHAT_COMPLETION_TIMEOUT_MS = 120_000;

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
export function isContextOverflowError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;
  if (/maximum context length/i.test(message)) return true; // OpenAI, vLLM
  return (
    /context[_ ](?:size|length|window)|context overflow/i.test(message) &&
    /exceed|overflow|too (?:large|long|big|many)/i.test(message)
  );
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
     * Bound for a thinking model's reasoning. Classification calls pass "low":
     * their answer is a small JSON verdict, and unbounded thinking was measured
     * costing more wall time than the verdict itself. Ignored by providers and
     * models without the knob.
     */
    reasoningEffort?: "low" | "medium" | "high";
    /** Reports the exact request body just before it is sent (for trace recording). */
    onRequest?: (requestBody: unknown) => void | Promise<void>;
  },
): Promise<ChatCompletionResult> {
  const priority = input.priority ?? "interactive";
  const requestBody = {
    model: input.model,
    messages: input.messages as ChatCompletionMessageParam[],
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  };
  const timeout =
    input.timeoutMs ??
    (priority === "background"
      ? BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS
      : CHAT_COMPLETION_TIMEOUT_MS);
  try {
    // Everything below runs inside the gate so the latency and the HTTP timeout
    // measure the wire, not the in-app queue; the queue wait shows up in traces
    // as the gap before the request event.
    return await withLlmPriority(priority, async () => {
      const start = Date.now();
      await input.onRequest?.(requestBody);
      const completion = await createOpenAiClient(conn).chat.completions.create(requestBody, {
        timeout,
      });
      const latencyMs = Date.now() - start;
      const content = completion.choices[0]?.message?.content?.trim() ?? "";
      if (!content) {
        throw ApiError.serviceUnavailable(
          finishReasonOf(completion) === "length"
            ? CONTEXT_EXHAUSTED_MESSAGE
            : "LLM returned an empty response",
        );
      }
      return {
        content,
        model: input.model,
        servedModel: servedModelOf(completion),
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        latencyMs,
        requestBody,
        responseBody: completion,
      };
    });
  } catch (err) {
    throw toLlmError(err, conn.baseUrl);
  }
}
