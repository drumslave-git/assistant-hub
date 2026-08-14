import { afterEach, describe, expect, it, vi } from "vitest";

import { imagePart } from "@/test/__mocks__/vision";
import {
  BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS,
  CHAT_COMPLETION_TIMEOUT_MS,
  CONTEXT_EXHAUSTED_MESSAGE,
  INTERACTIVE_RETRY_ATTEMPTS,
  INTERACTIVE_RETRY_DELAY_MS,
  isContextOverflowError,
  REPLY_CHAT_COMPLETION_TIMEOUT_MS,
  sanitizeMessagesForTrace,
  toOpenAiBaseUrl,
  type ChatMessage,
} from "./client";

describe("sanitizeMessagesForTrace", () => {
  it("leaves plain-text messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ];
    expect(sanitizeMessagesForTrace(messages)).toEqual(messages);
  });

  it("replaces inline image bytes with a compact byte-length marker", () => {
    const base64 = "A".repeat(2048);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "what is this?" }, imagePart(base64)],
      },
    ];
    const [sanitized] = sanitizeMessagesForTrace(messages);
    expect(sanitized.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,<2048 bytes>" } },
    ]);
  });

  it("does not mutate the input", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,ABCD" } }],
      },
    ];
    sanitizeMessagesForTrace(messages);
    expect((messages[0].content as { type: string }[])[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,ABCD" },
    });
  });

  it("replaces inline audio bytes with a compact byte-length marker, keeping the format", () => {
    const base64 = "B".repeat(4096);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this voice message." },
          { type: "input_audio", input_audio: { data: base64, format: "wav" } },
        ],
      },
    ];
    const [sanitized] = sanitizeMessagesForTrace(messages);
    expect(sanitized.content).toEqual([
      { type: "text", text: "Transcribe this voice message." },
      { type: "input_audio", input_audio: { data: "<4096 bytes>", format: "wav" } },
    ]);
    // The original is untouched.
    const original = (messages[0].content as { input_audio?: { data: string } }[])[1];
    expect(original.input_audio?.data).toBe(base64);
  });
});

describe("isContextOverflowError", () => {
  it.each([
    // llama.cpp oversized-prompt rejection, as mapped through toLlmError
    "LLM endpoint error (400): request (36280 tokens) exceeds the available context size (32768 tokens), try increasing it",
    // llama.cpp mid-generation exhaustion — different path, different wording
    // and status (seen live: trace a4859ca7, 2026-07-21)
    "LLM endpoint error (500): Context size has been exceeded.",
    // llama.cpp (older phrasing)
    "the request exceeds the available context size, try increasing the context size",
    // OpenAI / vLLM (no "exceeded" word at all)
    "This model's maximum context length is 32768 tokens. However, you requested 36280 tokens.",
    // OpenAI structured error code, when it lands in the message
    "400 context_length_exceeded",
    "context overflow detected",
    "prompt is too large for the context window",
    // Our own guard for a response Ollama cut off mid-generation — the contract
    // that lets shrink-and-retry callers recover from it must not drift.
    CONTEXT_EXHAUSTED_MESSAGE,
  ])("matches: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
    expect(isContextOverflowError(message)).toBe(true);
  });

  it.each([
    "LLM endpoint error (500): internal server error",
    "Connection to http://localhost:11434 timed out",
    "LLM returned an empty response",
  ])("does not match other failures: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false);
  });

  it("is false for non-error values", () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError({ status: 400 })).toBe(false);
  });
});

describe("toOpenAiBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(toOpenAiBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  it("keeps an existing /v1 and strips trailing slashes", () => {
    expect(toOpenAiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(toOpenAiBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434/v1");
  });

  it("rejects a blank URL", () => {
    expect(() => toOpenAiBaseUrl("   ")).toThrow();
  });
});

/**
 * The provider stub. Fixtures are written in the endpoint's own response shape —
 * that is what a reader needs to see to judge these tests — and translated to a
 * transport round below, which is the boundary `chatCompletion` actually calls.
 * Mocking there rather than inside the SDK keeps the tests about retry,
 * deadlines and result mapping, not about how the SDK is wired.
 */
const createMock = vi.fn();

vi.mock("./transport", () => ({
  completeRound: async (conn: unknown, input: { timeoutMs?: number }) => {
    const completion = (await createMock(conn, input)) as {
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = completion.choices?.[0];
    return {
      content: choice?.message?.content?.trim() ?? "",
      toolCalls: [],
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
      latencyMs: 1,
      requestBody: { model: completion.model },
      responseBody: completion,
      finishReason: choice?.finish_reason ?? "stop",
      servedModel: completion.model,
    };
  },
}));

// The OpenAI SDK is still mocked: its error classes are what
// `isRetryableLlmError` and `toLlmError` classify on the non-transport paths.
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    models = { list: vi.fn() };
  }
  class APIError extends Error {
    status?: number;
    constructor(message?: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class APIConnectionError extends Error {}
  // Mirrors the real SDK's hierarchy — a timeout IS a connection error, which is
  // what lets one `instanceof` check cover both in `isRetryableLlmError`.
  class APIConnectionTimeoutError extends APIConnectionError {}
  return { default: OpenAI, APIError, APIConnectionError, APIConnectionTimeoutError };
});

describe("toLlmError", () => {
  it("names the endpoint a fired deadline gave up on", async () => {
    const { toLlmError } = await import("./client");
    // What `AbortSignal.timeout` throws. Its own message names neither the host
    // nor the attempt, which is all a trace would otherwise have to show.
    const aborted = new Error("The operation was aborted due to timeout");
    aborted.name = "TimeoutError";
    expect(toLlmError(aborted, "http://endpoint.invalid/v1")).toMatchObject({
      code: "service_unavailable",
      message: "Request to http://endpoint.invalid/v1 timed out",
    });
  });

  it("treats a fired deadline as worth retrying — it says nothing about the request", async () => {
    const { isRetryableLlmError } = await import("./client");
    const aborted = new Error("aborted");
    aborted.name = "TimeoutError";
    expect(isRetryableLlmError(aborted)).toBe(true);
  });
});

describe("chatCompletion", () => {
  afterEach(() => createMock.mockReset());

  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  it("returns trimmed content, model, and normalized usage", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: "gemma:12b",
      choices: [{ message: { content: "  hello there  " } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    const result = await chatCompletion(conn, {
      model: "gemma:12b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hello there");
    expect(result.model).toBe("gemma:12b");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws service_unavailable when the model returns empty content", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ model: "m", choices: [{ message: { content: "   " } }] });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("names the context window when the empty response was cut off by it", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: "m",
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable", message: CONTEXT_EXHAUSTED_MESSAGE });
  });

  /**
   * A provider may resolve the requested tag to something else and report that.
   * Docker Model Runner answers `docker.io/ai/gemma4:26B` with the bundle path of
   * the file it loaded. Recording that as the call's identity made one configured
   * model appear as two in the dashboard, so identity stays the requested id and the
   * provider's answer is kept beside it.
   */
  it("keeps the requested id as the identity and records what was served", async () => {
    const { chatCompletion } = await import("./client");
    const bundlePath =
      "/models/bundles/sha256/95c8f7ac704f39390021259feb3d4849e85b42dca6b63014479fa4c3d48b4d86/model/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    createMock.mockResolvedValue({
      model: bundlePath,
      choices: [{ message: { content: "hi" } }],
    });

    const result = await chatCompletion(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.model).toBe("docker.io/ai/gemma4:26B");
    expect(result.servedModel).toBe(bundlePath);
  });

  it("leaves servedModel unset when the provider reports no model", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ choices: [{ message: { content: "hi" } }] });

    const result = await chatCompletion(conn, {
      model: "gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.model).toBe("gemma4:26B");
    expect(result.servedModel).toBeUndefined();
  });
});

/**
 * Recovery from a transient endpoint failure.
 *
 * The incident (2026-08-03, trace `82a8976c…`): one reply request hung until the
 * wire timeout while the endpoint served the very next call 0.2s later. The SDK
 * client is built with `maxRetries: 0` and nothing above it retried, so a single
 * hung connection cost a person their answer.
 */
describe("isRetryableLlmError", () => {
  /**
   * An `APIError` as the predicate sees one: the SDK's real constructor takes
   * (status, error, message, headers), and only the prototype and `status` are
   * what is actually inspected — so build exactly that and skip the ceremony.
   */
  async function apiError(message: string, status?: number): Promise<Error> {
    const { APIError } = await import("openai");
    return Object.assign(Object.create(APIError.prototype) as Error, { message, status });
  }

  it("retries the endpoint-fault family", async () => {
    const { isRetryableLlmError } = await import("./client");
    const { APIConnectionError, APIConnectionTimeoutError } = await import("openai");

    expect(isRetryableLlmError(new APIConnectionTimeoutError())).toBe(true);
    expect(isRetryableLlmError(new APIConnectionError({ message: "socket hang up" }))).toBe(true);
    expect(isRetryableLlmError(await apiError("upstream boom", 502))).toBe(true);
    // No status at all — the endpoint said nothing usable about why.
    expect(isRetryableLlmError(await apiError("???"))).toBe(true);
  });

  it("does not retry what the request itself caused", async () => {
    const { isRetryableLlmError } = await import("./client");

    // A rejected request is rejected identically every time; retrying one only
    // spends the deadline twice. 400 matters in particular: `toLlmError` flattens
    // it to `service_unavailable`, so the raw error is what has to be judged.
    expect(isRetryableLlmError(await apiError("bad request", 400))).toBe(false);
    expect(isRetryableLlmError(await apiError("unauthorized", 401))).toBe(false);
    expect(isRetryableLlmError(await apiError("forbidden", 403))).toBe(false);
    expect(isRetryableLlmError(new Error("something else"))).toBe(false);
  });

  it("never retries a context overflow — the fix is sending less", async () => {
    const { isRetryableLlmError } = await import("./client");

    expect(
      isRetryableLlmError(
        await apiError(
          "request (30000 tokens) exceeds the available context size (8192 tokens)",
          500,
        ),
      ),
    ).toBe(false);
    expect(isRetryableLlmError(new Error(CONTEXT_EXHAUSTED_MESSAGE))).toBe(false);
  });
});

describe("wire deadlines", () => {
  /**
   * The three deadlines exist because the three call shapes have genuinely
   * different latency distributions, measured on the live bot (2026-08-03):
   * classifications peaked at 57.7s, reply rounds at 95.8s over 118 of them, and
   * a summarize batch legitimately runs minutes. Collapsing any two of them back
   * into one is how a working reply round got cut at exactly 90.0s twice —
   * incident trace `93a963ec…`.
   */
  it("gives a reply more room than a classification, and a batch job more still", () => {
    expect(CHAT_COMPLETION_TIMEOUT_MS).toBeLessThan(REPLY_CHAT_COMPLETION_TIMEOUT_MS);
    expect(REPLY_CHAT_COMPLETION_TIMEOUT_MS).toBeLessThan(BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS);
    // Headroom over the slowest of each kind ever recorded, not a round number.
    expect(CHAT_COMPLETION_TIMEOUT_MS).toBeGreaterThan(57_700);
    expect(REPLY_CHAT_COMPLETION_TIMEOUT_MS).toBeGreaterThan(95_800);
  });

  it("applies the caller's deadline to the request", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ model: "m", choices: [{ message: { content: "hi" } }] });

    await chatCompletion(
      { baseUrl: "http://localhost:11434", apiKey: null },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS,
      },
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS }),
    );
    createMock.mockReset();
  });
});

describe("chatCompletion retries", () => {
  afterEach(() => {
    createMock.mockReset();
    vi.useRealTimers();
  });

  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  /**
   * Drive the pause between attempts without waiting it out for real. The no-op
   * catch runs before the first await purely to mark the promise handled — the
   * assertion below still sees the rejection, but Vitest does not flag it as
   * unhandled while the fake clock is being advanced.
   */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(INTERACTIVE_RETRY_DELAY_MS);
    return promise;
  }

  it("recovers a hung interactive call on the second attempt", async () => {
    const { chatCompletion } = await import("./client");
    const { APIConnectionTimeoutError } = await import("openai");
    createMock
      .mockRejectedValueOnce(new APIConnectionTimeoutError())
      .mockResolvedValue({ model: "m", choices: [{ message: { content: "hi" } }] });
    const onRetry = vi.fn();
    vi.useFakeTimers();

    const result = await settle(
      chatCompletion(conn, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        onRetry,
      }),
    );

    expect(result.content).toBe("hi");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, attempts: 2, delayMs: INTERACTIVE_RETRY_DELAY_MS }),
    );
  });

  it("gives up after the second failure with the mapped error", async () => {
    const { chatCompletion } = await import("./client");
    const { APIConnectionTimeoutError } = await import("openai");
    createMock.mockRejectedValue(new APIConnectionTimeoutError());
    vi.useFakeTimers();

    await expect(
      settle(chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      message: `Connection to ${conn.baseUrl} timed out`,
    });
    expect(createMock).toHaveBeenCalledTimes(INTERACTIVE_RETRY_ATTEMPTS);
  });

  it("does not retry a background call — it has its own schedule", async () => {
    const { chatCompletion } = await import("./client");
    const { APIConnectionTimeoutError } = await import("openai");
    createMock.mockRejectedValue(new APIConnectionTimeoutError());

    await expect(
      chatCompletion(conn, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        priority: "background",
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("does not retry an empty completion — the answer's fault is judged after the wire", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ model: "m", choices: [{ message: { content: "  " } }] });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(createMock).toHaveBeenCalledOnce();
  });
});

describe("llmUsageOf", () => {
  it("records the requested id and the served one side by side", async () => {
    const { llmUsageOf } = await import("./client");
    expect(
      llmUsageOf({
        model: "docker.io/ai/gemma4:26B",
        servedModel: "/models/bundles/sha256/abc/model/x.gguf",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        latencyMs: 5,
      }),
    ).toEqual({
      model: "docker.io/ai/gemma4:26B",
      servedModel: "/models/bundles/sha256/abc/model/x.gguf",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      latencyMs: 5,
    });
  });

  it("tolerates a completion that reported no usage", async () => {
    const { llmUsageOf } = await import("./client");
    const usage = llmUsageOf({ model: "m", latencyMs: 2 });
    expect(usage).toMatchObject({ model: "m", latencyMs: 2 });
    expect(usage.promptTokens).toBeUndefined();
  });
});

describe("listModels against an Anthropic backend", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists via the native route with x-api-key, following its pagination", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      requests.push({ url: u, headers: new Headers(init?.headers) });
      // Anthropic paginates with `has_more`/`last_id` — not the OpenAI shape.
      const body = u.searchParams.get("after_id")
        ? { data: [{ id: "claude-c" }], has_more: false, last_id: "claude-c" }
        : { data: [{ id: "claude-b" }, { id: "claude-a" }], has_more: true, last_id: "claude-a" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { listModels } = await import("./client");
    const models = await listModels({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-key",
      backend: "anthropic",
    });

    expect(models).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(requests[0].url.pathname).toBe("/v1/models");
    // Native auth: the key rides `x-api-key`, never `Authorization: Bearer` —
    // Anthropic answers a Bearer API key with 401 "Invalid bearer token".
    expect(requests[0].headers.get("x-api-key")).toBe("sk-ant-key");
    expect(requests[0].headers.get("anthropic-version")).toBeTruthy();
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[1].url.searchParams.get("after_id")).toBe("claude-a");
  });

  it("maps an auth failure to bad_request carrying the endpoint's own message", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
          { status: 401 },
        ),
    );

    const { listModels } = await import("./client");
    await expect(
      listModels({ baseUrl: "https://api.anthropic.com/v1", apiKey: "bad", backend: "anthropic" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "LLM endpoint error (401): invalid x-api-key",
    });
  });
});

describe("servedModelOf", () => {
  it("reads the model a response claims to have served", async () => {
    const { servedModelOf } = await import("./client");
    expect(servedModelOf({ model: "gemma4:26B" })).toBe("gemma4:26B");
  });

  it("is undefined when the response claims nothing usable", async () => {
    const { servedModelOf } = await import("./client");
    for (const body of [null, undefined, {}, { model: "" }, { model: "   " }, { model: 7 }, "nope"]) {
      expect(servedModelOf(body)).toBeUndefined();
    }
  });
});

describe("listModels against a Google backend", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists via the native route with x-goog-api-key, following its pagination", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      requests.push({ url: u, headers: new Headers(init?.headers) });
      // Google paginates with `pageToken`/`nextPageToken`, and namespaces ids.
      const body = u.searchParams.get("pageToken")
        ? { models: [{ name: "models/gemini-c" }] }
        : { models: [{ name: "models/gemini-b" }, { name: "models/gemini-a" }], nextPageToken: "p2" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { listModels } = await import("./client");
    const models = await listModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "goog-key",
      backend: "google",
    });

    // The `models/` namespace belongs to this route, not to the model: every
    // other route — and every stored selection — uses the bare id.
    expect(models).toEqual(["gemini-a", "gemini-b", "gemini-c"]);
    // `/v1beta`, not the `/v1` every OpenAI-shaped backend gets.
    expect(requests[0].url.pathname).toBe("/v1beta/models");
    expect(requests[0].headers.get("x-goog-api-key")).toBe("goog-key");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[1].url.searchParams.get("pageToken")).toBe("p2");
  });

  it("reads the message out of Google's array-wrapped error body", async () => {
    // The shape the operator's failing reply actually returned: a single-element
    // array, which every `{error:{message}}` reader misses.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify([
            { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } },
          ]),
          { status: 400 },
        ),
    );

    const { listModels } = await import("./client");
    await expect(
      listModels({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "bad",
        backend: "google",
      }),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      message: "LLM endpoint error (400): API key not valid",
    });
  });

  it("versions the base URL the way Gemini does, and leaves an explicit one alone", async () => {
    const { toGoogleBaseUrl } = await import("./client");
    expect(toGoogleBaseUrl("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(toGoogleBaseUrl("https://generativelanguage.googleapis.com/")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    // An operator who pinned a version said something specific.
    expect(toGoogleBaseUrl("https://proxy.invalid/v1alpha")).toBe("https://proxy.invalid/v1alpha");
    expect(toGoogleBaseUrl("https://proxy.invalid/v1")).toBe("https://proxy.invalid/v1");
  });
});
