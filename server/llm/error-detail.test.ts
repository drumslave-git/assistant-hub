import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiClient, toLlmError } from "./client";

/**
 * Error-body surfacing, driven through the REAL OpenAI SDK (this file deliberately
 * does not mock `openai` — the behaviour under test *is* the SDK's error parsing,
 * so mocking it would test nothing).
 *
 * The SDK only understands its own `{error: {…}}` shape and discards a JSON body
 * without it, reporting "500 status code (no body)". Every OpenAI-compatible
 * backend that answers FastAPI-style (`{"detail": …}`) hit that, throwing away the
 * server's actual explanation. These cases pin the fix and, just as importantly,
 * that a real OpenAI error still passes through untouched.
 */

const conn = { baseUrl: "https://provider.example.com/v1", apiKey: "k" };

/** Stub the global fetch with one canned error response. */
function stubFetch(status: number, body: string, contentType = "application/json") {
  const fetchMock = vi.fn(
    async () =>
      new Response(body, { status, headers: { "content-type": contentType } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Provoke a provider error and map it the way every caller does. */
async function callAndMapError(): Promise<string> {
  try {
    await createOpenAiClient(conn).chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
  } catch (err) {
    return toLlmError(err, conn.baseUrl).message;
  }
  throw new Error("expected the call to throw");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider error detail", () => {
  it("surfaces a FastAPI-style `detail` body instead of 'no body'", async () => {
    // The real body a broken image backend returned; the operator was shown
    // "500 status code (no body)" and the dtype bug stayed invisible.
    stubFetch(
      500,
      JSON.stringify({
        detail: "Image generation failed: Input type (c10::Half) and bias type (float) should be the same",
      }),
    );

    const message = await callAndMapError();

    expect(message).toContain("c10::Half");
    expect(message).not.toContain("no body");
  });

  it("surfaces a bare `message` body", async () => {
    stubFetch(503, JSON.stringify({ message: "model is still loading" }));

    expect(await callAndMapError()).toContain("model is still loading");
  });

  it("falls back to the whole body when the shape is unrecognized", async () => {
    stubFetch(500, JSON.stringify({ code: 17, reason: "kernel panic" }));

    // Better to hand over an unfamiliar object verbatim than to summarize away
    // the only evidence there is.
    const message = await callAndMapError();
    expect(message).toContain("kernel panic");
    expect(message).not.toContain("no body");
  });

  it("surfaces the upstream provider error a gateway relayed under metadata.raw", async () => {
    // OpenRouter's live shape: the top-level message is a generic "Provider
    // returned error"; the text naming what actually broke — here a chat
    // template rejecting the request — arrives only in `error.metadata.raw`.
    stubFetch(
      400,
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: "System role not supported by this template",
            provider_name: "SomeProvider",
          },
        },
      }),
    );

    const message = await callAndMapError();
    expect(message).toContain("Provider returned error");
    expect(message).toContain("System role not supported by this template");
    expect(message).toContain("SomeProvider");
  });

  it("leaves a real OpenAI-shaped error untouched", async () => {
    stubFetch(
      400,
      JSON.stringify({ error: { message: "Invalid model id", type: "invalid_request_error" } }),
    );

    const message = await callAndMapError();
    expect(message).toContain("Invalid model id");
    // 400 is a caller mistake, not the endpoint being down.
    expect(message).toContain("400");
  });

  it("reads as a sentence, not as a JSON blob", async () => {
    stubFetch(500, JSON.stringify({ detail: "the model is on fire" }));

    // The detail is what the operator (and the model) actually read, so it must not
    // arrive wrapped in braces and quotes.
    expect(await callAndMapError()).toBe("LLM endpoint error (500): the model is on fire");
  });

  it("still surfaces a plain-text error body", async () => {
    stubFetch(502, "upstream connect error", "text/plain");

    expect(await callAndMapError()).toContain("upstream connect error");
  });

  it("passes a successful response through untouched", async () => {
    const ok = { id: "1", model: "m", choices: [{ message: { content: "hi" } }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(ok), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await createOpenAiClient(conn).chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.choices[0].message.content).toBe("hi");
  });
});
