import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { runToolLoop, type ToolCallRecord, type ToolLoopRound } from "./tool-loop";

/** A function tool call as the provider would return it. */
function toolCall(id: string, name: string, args: Record<string, unknown>): ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A round that answers with content and no tool calls. */
function answer(content: string, latencyMs = 5): ToolLoopRound {
  return {
    assistantMessage: { role: "assistant", content },
    toolCalls: [],
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs,
    raw: { round: "answer" },
  };
}

/** A round that emits tool calls. */
function calls(toolCalls: ChatCompletionMessageToolCall[], latencyMs = 5): ToolLoopRound {
  return {
    assistantMessage: { role: "assistant", content: null, tool_calls: toolCalls },
    toolCalls,
    content: "",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs,
    raw: { round: "calls" },
  };
}

const okResult = (text: string): McpToolCallResult => ({ text });

describe("runToolLoop", () => {
  it("returns the answer immediately when the first round has no tool calls", async () => {
    const complete = vi.fn().mockResolvedValue(answer("done"));
    const callTool = vi.fn();
    const result = await runToolLoop({ seed: [], complete, callTool });
    expect(result).toMatchObject({ content: "done", rounds: 1, loopDetected: false });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("runs a tool then answers, recording the call and summing usage/latency", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "echo", { x: 1 })], 10))
      .mockResolvedValueOnce(answer("final", 20));
    const callTool = vi.fn().mockResolvedValue(okResult("tool said hi"));
    const recorded: ToolCallRecord[] = [];

    const result = await runToolLoop({
      seed: [{ role: "user", content: "hi" }],
      complete,
      callTool,
      onToolCall: (rec) => void recorded.push(rec),
    });

    expect(callTool).toHaveBeenCalledWith("echo", { x: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ name: "echo", args: { x: 1 }, ok: true });
    expect(result.content).toBe("final");
    expect(result.rounds).toBe(2);
    expect(result.latencyMs).toBe(30);
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 });
    // The tool result was appended to the conversation for the next round.
    const secondConversation = complete.mock.calls[1][0];
    expect(secondConversation.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "tool said hi",
    });
  });

  it("feeds tool-produced images back as a vision user turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "shot", {})]))
      .mockResolvedValueOnce(answer("seen it"));
    const dataUrl = "data:image/jpeg;base64,AAA";
    const callTool = vi
      .fn()
      .mockResolvedValue({ text: "screenshot captured", images: [dataUrl] } satisfies McpToolCallResult);

    const result = await runToolLoop({ seed: [], complete, callTool });

    expect(result.content).toBe("seen it");
    // The second round's conversation carries the tool text turn AND a following
    // vision user turn with the image — providers reject images in a `tool` role.
    const secondConversation = complete.mock.calls[1][0];
    const toolTurn = secondConversation.find(
      (m: { role: string }) => m.role === "tool",
    ) as { role: string; tool_call_id: string; content: string };
    expect(toolTurn).toMatchObject({ tool_call_id: "c1", content: "screenshot captured" });
    const visionTurn = secondConversation.at(-1) as {
      role: string;
      content: { type: string; image_url?: { url: string } }[];
    };
    expect(visionTurn.role).toBe("user");
    expect(visionTurn.content).toContainEqual({ type: "image_url", image_url: { url: dataUrl } });
  });

  it("appends no vision turn when no tool returned images", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "t", {})]))
      .mockResolvedValueOnce(answer("done"));
    const callTool = vi.fn().mockResolvedValue(okResult("plain result"));
    await runToolLoop({ seed: [], complete, callTool });
    const secondConversation = complete.mock.calls[1][0] as { role: string; content: unknown }[];
    expect(
      secondConversation.every((m) => m.role !== "user" || typeof m.content === "string"),
    ).toBe(true);
  });

  it("flags a tool error but keeps going", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "boom", {})]))
      .mockResolvedValueOnce(answer("recovered"));
    const callTool = vi.fn().mockRejectedValue(new Error("tool exploded"));
    const recorded: ToolCallRecord[] = [];

    const result = await runToolLoop({
      seed: [],
      complete,
      callTool,
      onToolCall: (rec) => void recorded.push(rec),
    });

    expect(recorded[0].ok).toBe(false);
    expect(recorded[0].result.text).toBe("tool exploded");
    expect(result.content).toBe("recovered");
  });

  it("treats an isError tool result as not-ok", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "t", {})]))
      .mockResolvedValueOnce(answer("ok"));
    const callTool = vi.fn().mockResolvedValue({ text: "bad range", isError: true });
    const recorded: ToolCallRecord[] = [];
    await runToolLoop({ seed: [], complete, callTool, onToolCall: (r) => void recorded.push(r) });
    expect(recorded[0].ok).toBe(false);
  });

  it("restates a failed call as a system turn naming the tool and its error", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "tasks_delete", { id: "nope" })]))
      .mockResolvedValueOnce(answer("it failed"));
    const callTool = vi.fn().mockResolvedValue({ text: "No task nope in this chat.", isError: true });

    await runToolLoop({ seed: [], complete, callTool });

    const secondConversation = complete.mock.calls[1][0] as { role: string; content: string }[];
    const notice = secondConversation.at(-1)!;
    expect(notice.role).toBe("system");
    expect(notice.content).toContain("tasks_delete: No task nope in this chat.");
    expect(notice.content).toContain("Nothing was done");
    expect(notice.content).toContain("Never answer as if a failed call had worked.");
  });

  it("appends no failure notice when every call succeeded", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "t", {})]))
      .mockResolvedValueOnce(answer("done"));
    const callTool = vi.fn().mockResolvedValue(okResult("fine"));
    await runToolLoop({ seed: [], complete, callTool });
    const secondConversation = complete.mock.calls[1][0] as { role: string }[];
    expect(secondConversation.some((m) => m.role === "system")).toBe(false);
  });

  it("lists every failed call of a round in one notice, leaving the successful ones out", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "a", {}), toolCall("c2", "b", {}), toolCall("c3", "c", {})]))
      .mockResolvedValueOnce(answer("done"));
    const callTool = vi.fn().mockImplementation(async (name: string) => {
      if (name === "b") return okResult("b's result");
      if (name === "c") throw new Error("exploded");
      return { text: "bad id", isError: true } satisfies McpToolCallResult;
    });

    await runToolLoop({ seed: [], complete, callTool });

    const secondConversation = complete.mock.calls[1][0] as { role: string; content: string }[];
    const notice = secondConversation.at(-1)!;
    expect(notice.content).toContain("- a: bad id");
    expect(notice.content).toContain("- c: exploded");
    expect(notice.content).not.toContain("b's result");
    expect(notice.content).not.toContain("- b:");
  });

  it("runs a round's tool calls concurrently, recording results in call order", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        calls([toolCall("c1", "a", { n: 1 }), toolCall("c2", "b", { n: 2 }), toolCall("c3", "c", { n: 3 })]),
      )
      .mockResolvedValueOnce(answer("done"));
    const gates = new Map<string, (result: McpToolCallResult) => void>();
    const started: string[] = [];
    const callTool = vi.fn().mockImplementation(
      (name: string) =>
        new Promise<McpToolCallResult>((resolve) => {
          started.push(name);
          gates.set(name, resolve);
        }),
    );
    const recorded: ToolCallRecord[] = [];
    const resultPromise = runToolLoop({
      seed: [],
      complete,
      callTool,
      onToolCall: (rec) => void recorded.push(rec),
    });

    // All three calls are dispatched before any result resolves — concurrent.
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    // Resolve in reverse order; reporting and the conversation stay in call order.
    gates.get("c")!(okResult("third"));
    gates.get("b")!(okResult("second"));
    gates.get("a")!(okResult("first"));

    const result = await resultPromise;
    expect(result.content).toBe("done");
    expect(recorded.map((r) => r.name)).toEqual(["a", "b", "c"]);
    const secondConversation = complete.mock.calls[1][0];
    expect(secondConversation.slice(-3)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "first" },
      { role: "tool", tool_call_id: "c2", content: "second" },
      { role: "tool", tool_call_id: "c3", content: "third" },
    ]);
  });

  it("caps how many of a round's tool calls run at once", async () => {
    const six = Array.from({ length: 6 }, (_, i) => toolCall(`c${i}`, "t", { i }));
    const complete = vi.fn().mockResolvedValueOnce(calls(six)).mockResolvedValueOnce(answer("done"));
    let inFlight = 0;
    let maxInFlight = 0;
    const callTool = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return okResult("x");
    });
    const result = await runToolLoop({ seed: [], complete, callTool });
    expect(result.content).toBe("done");
    expect(callTool).toHaveBeenCalledTimes(6);
    // MAX_PARALLEL_TOOL_CALLS in tool-loop.ts.
    expect(maxInFlight).toBe(4);
  });

  it("stops and flags a loop when the model repeats the same call with no progress", async () => {
    // Always the same call signature → no new action → stall guard trips.
    const complete = vi.fn().mockResolvedValue(calls([toolCall("c1", "spin", { n: 1 })]));
    const callTool = vi.fn().mockResolvedValue(okResult("again"));
    const result = await runToolLoop({ seed: [], complete, callTool });
    expect(result.loopDetected).toBe(true);
    expect(result.content).toBe("");
  });

  it("honors maxRounds as a hard cap", async () => {
    let n = 0;
    // Each round is a NEW call (progress), so only maxRounds stops it.
    const complete = vi.fn().mockImplementation(async () => calls([toolCall(`c${n}`, "t", { n: n++ })]));
    const callTool = vi.fn().mockResolvedValue(okResult("x"));
    const result = await runToolLoop({ seed: [], complete, callTool, maxRounds: 2 });
    expect(result.loopDetected).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("forces one tools-free final answer on a stall when completeFinal is provided", async () => {
    const complete = vi.fn().mockResolvedValue(calls([toolCall("c1", "spin", { n: 1 })]));
    const completeFinal = vi.fn().mockResolvedValue(answer("best effort", 7));
    const callTool = vi.fn().mockResolvedValue(okResult("again"));
    const reports: boolean[] = [];
    const result = await runToolLoop({
      seed: [],
      complete,
      completeFinal,
      callTool,
      onRound: (_round, report) => void reports.push(report.isFinal),
    });
    // Still flagged — the caller must be able to tell a forced answer from a real one.
    expect(result).toMatchObject({ content: "best effort", loopDetected: true });
    expect(completeFinal).toHaveBeenCalledTimes(1);
    // The forced round counts, carries its latency, and is reported as the final round.
    expect(result.rounds).toBe(complete.mock.calls.length + 1);
    expect(reports.at(-1)).toBe(true);
  });

  it("sends the compacted view each round while accumulating the full history", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(calls([toolCall("c1", "page", { p: 1 })]))
      .mockResolvedValueOnce(calls([toolCall("c2", "page", { p: 2 })]))
      .mockResolvedValueOnce(answer("done"));
    const callTool = vi.fn().mockResolvedValue(okResult("BIG PAGE STATE"));
    const compact = vi
      .fn()
      .mockImplementation((conversation: { role: string; content: unknown }[]) =>
        conversation.map((m) => (m.role === "tool" ? { ...m, content: "[stub]" } : m)),
      );

    const result = await runToolLoop({
      seed: [{ role: "user", content: "go" }],
      complete,
      callTool,
      compact,
    });

    expect(result.content).toBe("done");
    // The provider saw the rewritten view…
    const thirdConversation = complete.mock.calls[2][0] as { role: string; content: string }[];
    expect(thirdConversation.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "[stub]",
      "[stub]",
    ]);
    // …while compact was handed the intact history each round (1, +2, +2 messages),
    // with the real tool results still in place.
    expect(compact.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([1, 3, 5]);
    const lastSeen = compact.mock.calls[2][0] as { role: string; content: string }[];
    expect(lastSeen.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "BIG PAGE STATE",
      "BIG PAGE STATE",
    ]);
  });

  it("compacts the forced final round's conversation too", async () => {
    const complete = vi.fn().mockResolvedValue(calls([toolCall("c1", "spin", { n: 1 })]));
    const completeFinal = vi.fn().mockResolvedValue(answer("best effort"));
    const callTool = vi.fn().mockResolvedValue(okResult("huge"));
    const compact = vi
      .fn()
      .mockImplementation((conversation: { role: string; content: unknown }[]) =>
        conversation.map((m) => (m.role === "tool" ? { ...m, content: "[stub]" } : m)),
      );

    await runToolLoop({ seed: [], complete, completeFinal, callTool, compact });

    const finalConversation = completeFinal.mock.calls[0][0] as { role: string; content: string }[];
    expect(finalConversation.some((m) => m.content === "[stub]")).toBe(true);
    expect(finalConversation.some((m) => m.content === "huge")).toBe(false);
  });

  it("forces the final answer when maxRounds is exhausted", async () => {
    let n = 0;
    const complete = vi.fn().mockImplementation(async () => calls([toolCall(`c${n}`, "t", { n: n++ })]));
    const completeFinal = vi.fn().mockResolvedValue(answer("capped"));
    const callTool = vi.fn().mockResolvedValue(okResult("x"));
    const result = await runToolLoop({ seed: [], complete, completeFinal, callTool, maxRounds: 2 });
    expect(result).toMatchObject({ content: "capped", loopDetected: true, rounds: 3 });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

/**
 * The provider stub, scripted in the endpoint's own response shape and
 * translated to a transport round — the same seam `client.test.ts` mocks, so
 * both completion paths are exercised against an identical fake provider. That
 * matters here: the invariant these tests defend is that the two paths agree.
 */
const createMock = vi.fn();

vi.mock("./transport", () => ({
  completeRound: async (conn: unknown, input: unknown) => {
    const completion = (await createMock(conn, input)) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ChatCompletionMessageToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = completion.choices?.[0];
    return {
      content: choice?.message?.content?.trim() ?? "",
      toolCalls: choice?.message?.tool_calls ?? [],
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

// Still mocked for its error classes, which the retry predicate classifies on.
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    models = { list: vi.fn() };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  // A timeout IS a connection error in the real SDK — the hierarchy the retry
  // predicate relies on.
  class APIConnectionTimeoutError extends APIConnectionError {}
  return { default: OpenAI, APIError, APIConnectionError, APIConnectionTimeoutError };
});

/**
 * The invariant that actually broke: both completion paths return the same
 * `ChatCompletionResult`, so they must agree on what its fields mean. They did not —
 * the plain path recorded the provider's answer as `model` while this one
 * substituted the requested id, so merely enabling tools changed the recorded model
 * name and split one model's stats in two.
 */
describe("chatCompletionWithTools — result identity", () => {
  const conn = { baseUrl: "http://localhost:11434", apiKey: null };
  const bundlePath =
    "/models/bundles/sha256/95c8f7ac704f39390021259feb3d4849e85b42dca6b63014479fa4c3d48b4d86/model/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";

  afterEach(() => createMock.mockReset());

  it("reports the requested id and the served one, exactly like the plain path", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: bundlePath,
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });

    const withTools = await chatCompletionWithTools(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      callTool: async () => okResult(""),
    });
    const plain = await chatCompletion(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(withTools.model).toBe("docker.io/ai/gemma4:26B");
    expect(withTools.servedModel).toBe(bundlePath);
    // The whole point: turning tools on must not change how a call is identified.
    expect(withTools.model).toBe(plain.model);
    expect(withTools.servedModel).toBe(plain.servedModel);
  });

  it("leaves servedModel unset when the provider reports no model", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    createMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hello" } }],
    });

    const result = await chatCompletionWithTools(conn, {
      model: "gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      callTool: async () => okResult(""),
    });

    expect(result.model).toBe("gemma4:26B");
    expect(result.servedModel).toBeUndefined();
  });

  it("answers via a tools-free forced round when the model stalls", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    // A request that carries tools always stalls on the same call; the forced
    // final request must drop `tools`, and only then does the model answer.
    createMock.mockImplementation(async (body: { tools?: unknown[] }) =>
      body.tools
        ? {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall("c1", "spin", { n: 1 })],
                },
              },
            ],
          }
        : { choices: [{ message: { role: "assistant", content: "from what I have" } }] },
    );

    const result = await chatCompletionWithTools(conn, {
      model: "gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "spin", parameters: {} } }],
      callTool: async () => okResult("again"),
    });

    expect(result.content).toBe("from what I have");
    const finalBody = createMock.mock.calls.at(-1)?.[0] as { tools?: unknown };
    expect(finalBody.tools).toBeUndefined();
  });
});

/**
 * The failure this distinguishes (trace 622483e0, 2026-07-30): a run whose prompt
 * filled the whole context window got an empty round back (`finish_reason:
 * "length"` — the model was cut off before emitting content or a tool call) and
 * reported it as "LLM returned an empty response", pointing the operator at the
 * provider instead of at the prompt size.
 */
describe("chatCompletionWithTools — empty responses", () => {
  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  afterEach(() => createMock.mockReset());

  it("names the context window when the empty round was cut off by it", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const { CONTEXT_EXHAUSTED_MESSAGE, isContextOverflowError } = await import("./client");
    createMock.mockResolvedValue({
      model: "m",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 31845, completion_tokens: 923, total_tokens: 32768 },
    });

    const err: unknown = await chatCompletionWithTools(conn, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      callTool: async () => okResult(""),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: "service_unavailable", message: CONTEXT_EXHAUSTED_MESSAGE });
    // The wording is load-bearing: shrink-and-retry callers key on this predicate.
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("still reports a plain empty response when nothing was truncated", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    createMock.mockResolvedValue({
      model: "m",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    });

    await expect(
      chatCompletionWithTools(conn, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        callTool: async () => okResult(""),
      }),
    ).rejects.toMatchObject({ code: "service_unavailable", message: "LLM returned an empty response" });
  });
});

/**
 * A transient failure mid-conversation. The retry sits per *round*, and that
 * placement is the whole point: the loop's accumulated conversation — including
 * the results of tools that already ran — is what gets re-sent, so recovering
 * from a hung connection never re-executes a side effect. A retry around the
 * whole call would re-download the video.
 */
describe("chatCompletionWithTools — round retries", () => {
  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  afterEach(() => {
    createMock.mockReset();
    vi.useRealTimers();
  });

  it("retries the failed round only, keeping the tool result already gathered", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const { INTERACTIVE_RETRY_DELAY_MS } = await import("./client");
    const { APIConnectionTimeoutError } = await import("openai");
    const call = toolCall("c1", "browse_web", { url: "https://example.com/clip" });
    createMock
      // Round 1 asks for the download.
      .mockResolvedValueOnce({
        model: "m",
        choices: [{ message: { role: "assistant", content: null, tool_calls: [call] } }],
      })
      // Round 2 hangs, then answers on the retry.
      .mockRejectedValueOnce(new APIConnectionTimeoutError())
      .mockResolvedValue({
        model: "m",
        choices: [{ message: { role: "assistant", content: "sent it" } }],
      });
    const callTool = vi.fn().mockResolvedValue(okResult("downloaded"));
    vi.useFakeTimers();

    const pending = chatCompletionWithTools(conn, {
      model: "m",
      messages: [{ role: "user", content: "https://example.com/clip" }],
      tools: [],
      callTool,
    });
    await vi.advanceTimersByTimeAsync(INTERACTIVE_RETRY_DELAY_MS);
    const result = await pending;

    expect(result.content).toBe("sent it");
    // The download ran once, not once per attempt.
    expect(callTool).toHaveBeenCalledOnce();
    // And the retried round carried the tool result forward rather than restarting.
    // `[1]` is the transport's input; `[0]` is the connection.
    const retried = createMock.mock.calls[2][1].messages;
    expect(retried.at(-1)).toMatchObject({ role: "tool", content: "downloaded" });
  });
});
