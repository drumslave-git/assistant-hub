import "server-only";

import type { LlmCallKindId } from "@/features/analytics/llm-call-kind";
import {
  isContextOverflowError,
  type ChatCompletionResult,
  type ChatMessage,
  type LlmCallTrace,
} from "@/server/llm/client";
import type { TraceRecorder } from "@/server/trace";

import {
  batchMessages,
  MIN_SUMMARY_BATCH_CHARS,
  SUMMARY_BATCH_CHARS,
  type SummarizableMessage,
} from "../summary";

/**
 * Run one traced LLM pass per transcript batch — the loop shared by the two
 * whole-day jobs (history summarization and memory extraction), which differ
 * only in the prompt they build and the parser they feed the responses to.
 * Request/response recording rides the shared LLM tracing layer: each batch's
 * call records itself (endpoint, model, full body, usage) via the `LlmCallTrace`
 * this loop passes to `complete`.
 *
 * The char budget is a guess at what fits the model: it cannot see tokenization,
 * so a batch the budget accepted can still be rejected by the endpoint as too
 * large. When that happens the not-yet-summarized messages are re-batched at
 * half the budget and the pass retried, down to {@link MIN_SUMMARY_BATCH_CHARS};
 * batches that already completed are kept. Any other failure propagates — the
 * day stays pending and the caller's trace records it.
 */
export async function completeTranscriptBatches(params: {
  messages: readonly SummarizableMessage[];
  /** The full request for one batch (system prompt + the batch's transcript). */
  buildRequest: (batch: readonly SummarizableMessage[]) => ChatMessage[];
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  trace: Pick<TraceRecorder, "event">;
  callKind: LlmCallKindId;
}): Promise<string[]> {
  const { trace } = params;
  let budget = SUMMARY_BATCH_CHARS;
  let queue: readonly SummarizableMessage[] = params.messages;
  const contents: string[] = [];

  const initialBatches = batchMessages(queue, budget).length;
  if (initialBatches > 1) {
    await trace.event({
      type: "step",
      message: "transcript batched",
      data: { batches: initialBatches, reason: "day exceeds one model pass" },
    });
  }

  while (queue.length > 0) {
    const remaining = batchMessages(queue, budget);
    const batch = remaining[0];
    const total = contents.length + remaining.length;
    const label = total > 1 ? `batch ${contents.length + 1}/${total}` : undefined;
    const request = params.buildRequest(batch);

    let completion: ChatCompletionResult;
    try {
      completion = await params.complete(request, {
        recorder: trace,
        callKind: params.callKind,
        ...(label ? { label } : {}),
      });
    } catch (err) {
      if (isContextOverflowError(err) && budget > MIN_SUMMARY_BATCH_CHARS) {
        budget = Math.max(Math.floor(budget / 2), MIN_SUMMARY_BATCH_CHARS);
        await trace.event({
          type: "step",
          level: "warn",
          message: `batch exceeded the model context — re-batching at ${budget} chars`,
          data: {
            budgetChars: budget,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        continue;
      }
      throw err;
    }

    contents.push(completion.content);
    queue = queue.slice(batch.length);
  }

  return contents;
}
