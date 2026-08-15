import { describe, expect, it, vi } from "vitest";

import type { TraceEvent } from "@/lib/trace";
import type { ChatCompletionResult, ChatMessage, LlmCallTrace } from "@/server/llm/client";
import type { EventInput } from "@/server/trace";

import type { SummarizableMessage } from "../summary";
import { completeTranscriptBatches } from "./batched-completion";

/**
 * The shared batch runner in isolation: batching labels, the context-overflow
 * shrink-and-retry, and the floor. No DB — the trace is a capturing stub and the
 * "model" is a function of the request size.
 */

/** llama.cpp's live phrasing for a too-large request — pinned, per the client tests. */
const OVERFLOW_MESSAGE = "LLM endpoint error (500): Context size has been exceeded.";

function msg(id: number, chars: number): SummarizableMessage {
  return {
    telegramMessageId: id,
    role: "user",
    content: "x".repeat(chars),
    label: "Alice",
    userId: "1",
    sentAt: "2026-07-16T10:00:00.000Z",
  };
}

function completion(content: string): ChatCompletionResult {
  return {
    content,
    model: "test-model",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    requestBody: {},
    responseBody: { choices: [{ message: { content } }] },
  };
}

function captureTrace() {
  const events: EventInput[] = [];
  return {
    events,
    trace: {
      event: async (input: EventInput) => {
        events.push(input);
        return {} as TraceEvent;
      },
    },
  };
}

/** System turn + the batch's raw contents as the user turn. */
function buildRequest(batch: readonly SummarizableMessage[]): ChatMessage[] {
  return [
    { role: "system", content: "S" },
    { role: "user", content: batch.map((m) => m.content).join("\n") },
  ];
}

/** The dep's shape, so `mock.calls` carries the trace options the loop passes. */
type Complete = (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;

/** A model that rejects any user turn longer than `limit` chars as an overflow. */
function modelWithContextLimit(limit: number) {
  let pass = 0;
  return vi.fn<Complete>(async (messages) => {
    if ((messages[1].content as string).length > limit) throw new Error(OVERFLOW_MESSAGE);
    pass += 1;
    return completion(`pass ${pass}`);
  });
}

describe("completeTranscriptBatches", () => {
  it("runs a small day as a single pass, handing the call its recording options", async () => {
    const { trace } = captureTrace();
    const complete = vi.fn<Complete>(async () => completion("ok"));

    const contents = await completeTranscriptBatches({
      messages: [msg(1, 100), msg(2, 100)],
      buildRequest,
      complete,
      trace,
      callKind: "history-summarize",
    });

    expect(contents).toEqual(["ok"]);
    expect(complete).toHaveBeenCalledTimes(1);
    // The shared LLM tracing layer does the recording; this loop's job is to
    // pass the trace, the call kind, and no batch label on a single pass.
    expect(complete.mock.calls[0][1]).toEqual({
      recorder: trace,
      callKind: "history-summarize",
    });
  });

  it("splits a large day into batches labelled for the trace", async () => {
    const { events, trace } = captureTrace();
    const complete = modelWithContextLimit(Number.MAX_SAFE_INTEGER);

    // 40 × 1000 chars blows the 24k budget → two batches.
    const contents = await completeTranscriptBatches({
      messages: Array.from({ length: 40 }, (_, i) => msg(i + 1, 1000)),
      buildRequest,
      complete,
      trace,
      callKind: "history-summarize",
    });

    expect(contents).toEqual(["pass 1", "pass 2"]);
    expect(events.map((e) => e.message)).toEqual(["transcript batched"]);
    // Each batch's call carries its own label, so the recorded events read
    // "batch 1/2 request" / "batch 1/2 response" in the trace.
    expect(complete.mock.calls.map((c) => (c[1] as { label?: string } | undefined)?.label)).toEqual([
      "batch 1/2",
      "batch 2/2",
    ]);
  });

  it("re-batches at half the budget when the model rejects a batch as too large", async () => {
    const { events, trace } = captureTrace();
    // The first ~22-message batch (~22k chars) overflows; 11-message batches fit.
    const complete = modelWithContextLimit(13_000);

    const contents = await completeTranscriptBatches({
      messages: Array.from({ length: 40 }, (_, i) => msg(i + 1, 1000)),
      buildRequest,
      complete,
      trace,
      callKind: "history-summarize",
    });

    expect(contents).toEqual(["pass 1", "pass 2", "pass 3", "pass 4"]);
    expect(complete).toHaveBeenCalledTimes(5); // 1 rejected + 4 accepted
    const warn = events.find((e) => e.level === "warn");
    expect(warn?.message).toContain("re-batching at 12000 chars");
    expect(warn?.data).toMatchObject({ budgetChars: 12_000, error: OVERFLOW_MESSAGE });
  });

  it("keeps completed batches when a later batch overflows, retrying only the rest", async () => {
    const { trace } = captureTrace();
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error(OVERFLOW_MESSAGE); // second batch too big
      return completion(`pass ${call}`);
    });

    const contents = await completeTranscriptBatches({
      messages: Array.from({ length: 40 }, (_, i) => msg(i + 1, 1000)),
      buildRequest,
      complete,
      trace,
      callKind: "history-summarize",
    });

    // Pass 1's result survives; only the remaining 18 messages were re-batched.
    expect(contents).toEqual(["pass 1", "pass 3", "pass 4"]);
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it("gives up at the floor budget and rethrows the overflow", async () => {
    const { trace } = captureTrace();
    const complete = vi.fn(async () => {
      throw new Error(OVERFLOW_MESSAGE);
    });

    await expect(
      completeTranscriptBatches({
        messages: [msg(1, 5000)],
        buildRequest,
        complete,
        trace,
        callKind: "history-summarize",
      }),
    ).rejects.toThrow("Context size has been exceeded");
    // One attempt per budget step: 24000 → 12000 → 6000 → 3000 → 1500 (floor).
    expect(complete).toHaveBeenCalledTimes(5);
  });

  it("rethrows a non-overflow failure without retrying", async () => {
    const { trace } = captureTrace();
    const complete = vi.fn(async () => {
      throw new Error("model exploded");
    });

    await expect(
      completeTranscriptBatches({
        messages: [msg(1, 100)],
        buildRequest,
        complete,
        trace,
        callKind: "history-summarize",
      }),
    ).rejects.toThrow("model exploded");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
