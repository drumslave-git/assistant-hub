import "server-only";

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { ApiError } from "@/lib/api-error";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { adapterFor, type ReasoningMode } from "./backends";
import {
  CHAT_COMPLETION_TIMEOUT_MS,
  CONTEXT_EXHAUSTED_MESSAGE,
  finishReasonOf,
  servedModelOf,
  withLlmRetry,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatUsage,
  type LlmConnection,
  type LlmRetryInfo,
} from "./client";
import { withLlmPriority, type LlmPriority } from "./priority";
import { completeRound, type LoopToolCall } from "./transport";

/**
 * Chat completion with tools as ONE conversation. Each round the model either
 * answers — that response is the reply — or emits tool calls, whose results are
 * appended and the same conversation re-sent. There is no separate tool-selection
 * pass: every request carries the same system prompt, so a turn that needs no
 * tools costs a single inference and keeps the provider's prompt-cache prefix.
 *
 * Termination is progress-driven (ported from the MVP): a round with no tool
 * calls ends the loop; a streak of {@link MAX_STALL_ROUNDS} rounds that each
 * introduce no new call (a stuck or looping model) takes the tools away for one
 * final forced answer, and the result is flagged `loopDetected`.
 */

/** A single executed tool call, surfaced to the caller for trace recording. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: McpToolCallResult;
  ok: boolean;
}

/** One model round, as produced by the injected completion function. */
export interface ToolLoopRound {
  /** The assistant message (with `tool_calls` and/or content) to append verbatim. */
  assistantMessage: ChatCompletionMessageParam;
  toolCalls: LoopToolCall[];
  content: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Raw provider response for this round (recorded as the final response body). */
  raw: unknown;
}

/** Runs one model round over the current conversation. */
export type CompleteRound = (
  conversation: ChatCompletionMessageParam[],
) => Promise<ToolLoopRound>;

/** What a completed round was: an intermediate tool turn, or the answer. */
export interface RoundReport {
  /** 0-based position in the loop. */
  index: number;
  /** True when the model answered instead of asking for tools — the reply round. */
  isFinal: boolean;
}

export interface RunToolLoopParams {
  seed: ChatCompletionMessageParam[];
  complete: CompleteRound;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
  onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
  /**
   * Reports every model round as it completes, with its own tokens and latency.
   *
   * The loop's summed {@link ToolLoopResult} is still what the caller returns to the
   * user, but a sum is the wrong unit for performance: a reply that took four rounds
   * and one that answered immediately became the same indistinguishable row, and a
   * single slow tool turn was invisible inside the total. Analytics groups on the
   * round, so it needs each one.
   */
  onRound?: (round: ToolLoopRound, report: RoundReport) => void | Promise<void>;
  /**
   * Reports a round that produced neither an answer nor a tool call, and is being
   * asked again — see {@link EMPTY_ROUND_NOTICE}. Visible, not silent: a turn that
   * took an extra round must not pass for a clean one on Debug.
   */
  onEmptyRound?: (attempt: number) => void | Promise<void>;
  /** Hard cap on model rounds; unset = unbounded (progress guard still applies). */
  maxRounds?: number;
  /**
   * Runs one round with the tools taken away. Used for the forced final answer
   * when the stall guard or round cap stops the loop — a degraded answer from
   * what the model already gathered beats a hard failure — and for an empty
   * round that followed real work, where withholding the tools is what stops a
   * replayed mutation (see {@link EMPTY_ROUND_AFTER_WORK_NOTICE}). Unset = the
   * stall surfaces as-is (empty content, `loopDetected`), and an empty round is
   * re-asked with the tools still offered.
   */
  completeFinal?: CompleteRound;
  /**
   * Rewrites what each round *sends* without touching what the loop *keeps*.
   * Called with a copy of the accumulated conversation before every model round
   * (including the forced final); the returned array is what goes to the
   * provider. This is how a caller whose tool results go stale (the browser
   * agent's page snapshots, superseded by every action) keeps the prompt from
   * growing until it overflows the context window. The rewrite must keep the
   * conversation valid — tool messages keep their role and `tool_call_id`, only
   * content may be replaced. Unset = the full conversation is sent as-is.
   */
  compact?: (conversation: ChatCompletionMessageParam[]) => ChatCompletionMessageParam[];
}

export interface ToolLoopResult {
  content: string;
  usage: ChatUsage;
  /** Summed latency across every model round. */
  latencyMs: number;
  rounds: number;
  /** Raw provider response of the final round. */
  responseBody: unknown;
  /**
   * True when the stall guard or round cap stopped the loop. With a
   * {@link RunToolLoopParams.completeFinal} the content is then the forced
   * tools-free answer; without one it is empty.
   */
  loopDetected: boolean;
}

/**
 * A streak of this many rounds that each introduce no tool call we have not
 * already run means the model has stalled. A single repeated call is not a stall
 * (iterating over items legitimately re-runs the same call), so only a run of
 * no-new-action rounds stops the loop. The streak resets on any new call.
 */
const MAX_STALL_ROUNDS = 3;

/**
 * Default hard cap on model rounds in {@link chatCompletionWithTools} when the
 * caller sets none. The stall guard never trips a model that keeps inventing
 * *novel* calls (each new argument string resets the streak), so without a cap
 * such a model could loop indefinitely. Generous — a legitimate reply with
 * research rarely needs more than a handful of rounds.
 */
const DEFAULT_MAX_ROUNDS = 16;

/**
 * How many of a round's tool calls may run at once. A model that emits several
 * independent lookups in one round (three history searches, a search plus a
 * page read) should not pay for them serially, but an unbounded batch could
 * stampede the DB pool or Playwright — so parallel, with a small cap.
 */
const MAX_PARALLEL_TOOL_CALLS = 4;

/**
 * How many times a round that produced *nothing* — no message text, no tool
 * call — is asked again before the loop gives up on it. One: a second empty
 * round is a model that has nothing to say, not a glitch, and the caller's
 * empty-answer failure is the honest outcome.
 */
const MAX_EMPTY_ROUND_RETRIES = 1;

/**
 * Shown to the model after a round that produced neither an answer nor a tool
 * call (user decision, 2026-08-08).
 *
 * Production trace `ef8634e5…`: asked to find a photo somebody had posted, the
 * model reasoned its way to the correct call and then emitted it *inside its
 * reasoning* as literal text — `<|tool_call>call:history_search{author:…}` — with
 * the chat template's quote tokens leaking into the argument values. The API
 * response therefore carried no `tool_calls`, empty content, and
 * `finish_reason: "stop"`: 600 tokens spent, no work started, and the chat got a
 * failure notice instead of an answer.
 *
 * A round like that is a mechanical fact worth acting on, not a judgement about
 * what the model should have chosen: it decided, and the decision did not leave
 * the model. So the retry restates the one thing that was wrong — where the call
 * has to go — and leaves both exits open, exactly like {@link toolFailureNotice}.
 * Nothing is parsed out of the reasoning text: a call reconstructed from garbled
 * pseudo-syntax would be a call the model never actually made.
 */
export const EMPTY_ROUND_NOTICE =
  "Your last turn produced nothing: no message and no tool call. Nothing was run and nobody " +
  "received anything. If you decided to use a tool, it must be emitted as a real tool call — a " +
  "tool call written out inside your thinking is not one and never runs. Do it now: either make " +
  "the tool call for real, or write the plain answer. Do not describe what you are about to do " +
  "instead of doing it.";

/**
 * Shown instead of {@link EMPTY_ROUND_NOTICE} when the turn has already executed
 * tool calls — and shown to a round with the **tools withheld**, because at that
 * point the only thing missing is the answer.
 *
 * Production trace `796852a6…` (2026-08-14): the model answered *and* called
 * `tasks_create` in one round, the next round came back completely empty (two
 * output tokens, no content, no calls), and the notice above told it "Nothing
 * was run and nobody received anything" — false, and the model did the sensible
 * thing with a false premise: it made the same `tasks_create` call again. Two
 * identical reminders, three seconds apart.
 *
 * A retry is safe for a round that did nothing and unsafe for one that did
 * something, so the two cases cannot share a notice — and telling a model not to
 * repeat a mutation is weaker than not offering it the tool.
 */
export const EMPTY_ROUND_AFTER_WORK_NOTICE =
  "Your last turn produced nothing: no message and no tool call. The tool calls earlier in this " +
  "turn DID run — their results are above, and the work they did is done. Nothing needs doing " +
  "again, and calling the same tool a second time would repeat that work for real. What is " +
  "missing is your answer to the person: write it now, in plain words, from the results above.";

/**
 * Map `items` through `fn` with at most `limit` in flight, results in input
 * order. `fn` must not reject (the tool executor catches internally).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

function toolCallSignature(call: ChatCompletionMessageToolCall): string {
  if (call.type !== "function" || !call.function?.name) return "";
  return `${call.function.name}:${call.function.arguments ?? ""}`;
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty args
  }
  return {};
}

/**
 * The system turn appended after a round in which one or more tool calls failed.
 *
 * Written against a production failure (2026-08-05): a reply model copied a task
 * id with one character dropped, `tasks_delete` came back `isError`, and the
 * reply told the user the task was cancelled while it stayed scheduled. Its own
 * reasoning shows it read the failure, could not explain it, and answered as if
 * it had succeeded anyway. The honesty rules in the feature's system prompt
 * say exactly that this is forbidden; a small local model still did it, because
 * by the final round those rules are thousands of tokens back and the failure is
 * one unremarkable `tool` message.
 *
 * So the failure is restated as its own instruction, at the point in the
 * conversation where the model is choosing what to do next, naming both allowed
 * exits: fix the call and retry (the loop still has rounds left), or tell the
 * user it failed. Generic on purpose — every tool loop in the app gets it.
 */
export function toolFailureNotice(failed: ToolCallRecord[]): string {
  return [
    failed.length === 1 ? "The tool call above FAILED:" : "The tool calls above FAILED:",
    ...failed.map((record) => `- ${record.name}: ${record.result.text}`),
    "Nothing was done — no data was changed, created, or removed by a failed call. " +
      "If the error says what was wrong with the call (a wrong or malformed id, a bad " +
      "argument), fix it and call the tool again now. If you cannot fix it, tell the user " +
      "plainly that it failed and what failed. Never answer as if a failed call had worked.",
  ].join("\n");
}

function addUsage(into: ChatUsage, add?: ChatUsage): void {
  if (!add) return;
  if (add.promptTokens != null) into.promptTokens = (into.promptTokens ?? 0) + add.promptTokens;
  if (add.completionTokens != null) {
    into.completionTokens = (into.completionTokens ?? 0) + add.completionTokens;
  }
  if (add.totalTokens != null) into.totalTokens = (into.totalTokens ?? 0) + add.totalTokens;
}

/**
 * Progress-driven tool-call loop over an injected {@link CompleteRound}. Pure of
 * any provider SDK, so it is unit-testable with a fake completion function.
 */
export async function runToolLoop(params: RunToolLoopParams): Promise<ToolLoopResult> {
  const conversation = [...params.seed];
  const usage: ChatUsage = {};
  const seen = new Set<string>();
  let latencyMs = 0;
  let stalls = 0;
  /** Rounds that produced neither an answer nor a tool call, and were re-asked. */
  let emptyRounds = 0;
  let rounds = 0;
  let lastRaw: unknown = null;

  // What a round sends: the compacted view when the caller provided one, the
  // accumulated conversation itself otherwise. Compaction runs on a copy each
  // round so the kept history stays complete and the rewrite stays stateless.
  const sendable = (): ChatCompletionMessageParam[] =>
    params.compact ? params.compact([...conversation]) : conversation;

  // Ask once more with the tools withheld, for an answer from what the model
  // already has. Two callers, distinguished by `stalled`: the stall guard and
  // the round cap (the model is stuck or out of budget — the result stays
  // flagged so callers can tell a forced answer from a real one), and an empty
  // round that followed real work (not a stall: the work is done, only the
  // answer is missing).
  const forceAnswer = async (stalled: boolean): Promise<ToolLoopResult> => {
    if (!params.completeFinal) {
      return { content: "", usage, latencyMs, rounds, responseBody: lastRaw, loopDetected: stalled };
    }
    const round = await params.completeFinal(sendable());
    rounds += 1;
    latencyMs += round.latencyMs;
    addUsage(usage, round.usage);
    await params.onRound?.(round, { index: rounds - 1, isFinal: true });
    return {
      content: round.content,
      usage,
      latencyMs,
      rounds,
      responseBody: round.raw,
      loopDetected: stalled,
    };
  };

  for (;;) {
    if (params.maxRounds != null && rounds >= params.maxRounds) {
      return forceAnswer(true);
    }

    const round = await params.complete(sendable());
    rounds += 1;
    latencyMs += round.latencyMs;
    addUsage(usage, round.usage);
    lastRaw = round.raw;

    const toolCalls = round.toolCalls;
    // A round that asked for no tools is the answer; anything else is a tool turn.
    await params.onRound?.(round, { index: rounds - 1, isFinal: toolCalls.length === 0 });

    // Neither an answer nor a tool call: nothing the chat can receive. Ask once
    // more before giving up — but *what* is asked depends on whether this turn
    // has already run tools. Nothing has run yet: re-ask with the tools, since
    // the missing thing may well be a call (EMPTY_ROUND_NOTICE). Work has run:
    // re-ask with the tools withheld, because the only thing missing is the
    // answer and an identical call replayed after a glitch does its work twice
    // for real (EMPTY_ROUND_AFTER_WORK_NOTICE, trace `796852a6…`).
    if (toolCalls.length === 0 && !round.content.trim() && emptyRounds < MAX_EMPTY_ROUND_RETRIES) {
      emptyRounds += 1;
      const afterWork = seen.size > 0 && params.completeFinal != null;
      conversation.push({
        role: "system",
        content: afterWork ? EMPTY_ROUND_AFTER_WORK_NOTICE : EMPTY_ROUND_NOTICE,
      });
      await params.onEmptyRound?.(emptyRounds);
      if (afterWork) return forceAnswer(false);
      continue;
    }

    if (toolCalls.length === 0) {
      return {
        content: round.content,
        usage,
        latencyMs,
        rounds,
        responseBody: round.raw,
        loopDetected: false,
      };
    }

    // Stall guard: a round is progress if it introduces a call we have not run.
    const introducesNew = toolCalls.some((c) => !seen.has(toolCallSignature(c)));
    if (introducesNew) {
      stalls = 0;
    } else if ((stalls += 1) >= MAX_STALL_ROUNDS) {
      return forceAnswer(true);
    }

    conversation.push(round.assistantMessage);

    const calls = toolCalls.flatMap((call) => {
      if (call.type !== "function" || !call.function?.name) return [];
      seen.add(toolCallSignature(call));
      return [{ id: call.id, name: call.function.name, args: parseToolArguments(call.function.arguments) }];
    });

    // A round's calls are independent by construction (the model asked for all of
    // them before seeing any result), so they run concurrently — capped, since a
    // batch of Playwright reads or DB scans should not land at once.
    const records = await mapWithConcurrency(calls, MAX_PARALLEL_TOOL_CALLS, async ({ name, args }) => {
      let result: McpToolCallResult;
      let ok = true;
      try {
        result = await params.callTool(name, args);
        ok = !result.isError;
      } catch (err) {
        ok = false;
        result = { text: err instanceof Error ? err.message : "Tool execution failed", isError: true };
      }
      return { name, args, result, ok } satisfies ToolCallRecord;
    });

    // Report and append in call-list order regardless of completion order, so
    // traces and the conversation the model re-reads stay deterministic.
    for (let i = 0; i < calls.length; i += 1) {
      await params.onToolCall?.(records[i]);
      conversation.push({ role: "tool", tool_call_id: calls[i].id, content: records[i].result.text });
    }

    // A failed call is restated as an instruction of its own — see
    // {@link toolFailureNotice} for why the surrounding prompt is not enough.
    const failed = records.filter((record) => !record.ok);
    if (failed.length > 0) {
      conversation.push({ role: "system", content: toolFailureNotice(failed) });
    }

    // A tool that produced images for the model (e.g. a browser screenshot)
    // cannot put them in the `tool` message — providers accept text there — so
    // they follow as a vision user turn, the same shape a photo message uses.
    const images = records.flatMap((record) => record.result.images ?? []);
    if (images.length > 0) {
      conversation.push({
        role: "user",
        content: [
          { type: "text", text: "Image(s) produced by the tool call(s) above:" },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      });
    }
  }
}

/**
 * Map our chat turns to OpenAI message params. Roles map 1:1; content is either
 * plain text or (for a vision `user` turn) an array of text/image parts, both of
 * which the SDK's user-message param accepts — the cast bridges our simplified
 * union to the role-specific param types.
 */
function toSeedMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam);
}

/**
 * Generate a chat completion with tool support against an OpenAI-compatible
 * endpoint. Returns the same {@link ChatCompletionResult} shape as
 * {@link chatCompletion} so the caller records request/response bodies and usage
 * uniformly. A stalled loop degrades to a forced tools-free final answer; only a
 * provider failure or an empty final content throws a clean {@link ApiError}.
 */
export async function chatCompletionWithTools(
  conn: LlmConnection,
  input: {
    model: string;
    messages: ChatMessage[];
    tools: ChatCompletionTool[];
    callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
    onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
    /** Reports the exact initial request body just before the first round is sent. */
    onRequest?: (requestBody: unknown) => void | Promise<void>;
    /** Reports a round being retried after a transient failure — see `withLlmRetry`. */
    onRetry?: (info: LlmRetryInfo) => void | Promise<void>;
    /** Reports each model round's own tokens/latency — see {@link RunToolLoopParams.onRound}. */
    onRound?: (round: ToolLoopRound, report: RoundReport) => void | Promise<void>;
    /** Reports an empty round being re-asked — see {@link RunToolLoopParams.onEmptyRound}. */
    onEmptyRound?: (attempt: number) => void | Promise<void>;
    /** Per-round conversation rewrite — see {@link RunToolLoopParams.compact}. */
    compact?: (conversation: ChatCompletionMessageParam[]) => ChatCompletionMessageParam[];
    maxRounds?: number;
    timeoutMs?: number;
    /** Dispatch priority for every round on the shared endpoint — see `priority.ts`. */
    priority?: LlmPriority;
    /** Hard cap on generated tokens per round — see `chatCompletion`'s `maxTokens`. */
    maxTokens?: number;
    /** What to ask of a thinking model per round — see `chatCompletion`'s `reasoning`. */
    reasoning?: ReasoningMode;
  },
): Promise<ChatCompletionResult> {
  const seed = toSeedMessages(input.messages);
  const maxTokensField =
    input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {};
  const requestBody = {
    model: input.model,
    messages: seed,
    tools: input.tools,
    ...maxTokensField,
    ...adapterFor(conn.backend).chatBodyExtras({ reasoning: input.reasoning }),
  };
  const timeout = input.timeoutMs ?? CHAT_COMPLETION_TIMEOUT_MS;
  const priority = input.priority ?? "interactive";

  // Report the initial request body (model + messages + tools) before the first
  // round so the trace records what the model was actually sent, in order — the
  // request precedes any tool-call events the loop then produces.
  await input.onRequest?.(requestBody);

  // One factory for both round kinds so the forced final answer is exactly the
  // same request minus the tools (a model that cannot ask for tools must answer).
  //
  // The retry sits per *round*, which is what makes it safe here: everything the
  // loop has already gathered stays in `conversation`, so a hung connection after
  // a download is a re-ask for the next model turn, never a second download.
  const completeWith =
    (tools: ChatCompletionTool[] | undefined): CompleteRound =>
    (conversation) =>
      withLlmRetry(
        () =>
          // Each round takes the gate on its own, so tool executions between
          // rounds never hold the endpoint slot.
          withLlmPriority(priority, async () => {
            const round = await completeRound(conn, {
              model: input.model,
              messages: conversation,
              ...(tools ? { tools } : {}),
              ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
              ...(input.reasoning ? { reasoning: input.reasoning } : {}),
              timeoutMs: timeout,
            });
            // Rebuilt rather than taken from the provider: the transport speaks
            // the SDK's shape, and what the loop appends to `conversation` must
            // be the OpenAI shape it feeds back on the next round. `tool_calls`
            // is omitted when empty — a `null` there is rejected by some
            // backends on the following request. The calls are appended as the
            // transport made them, vendor extras included: a Gemini call replayed
            // without its thought signature is a 400 on the very next round (see
            // `ToolCallExtraContent`).
            const assistantMessage = {
              role: "assistant",
              content: round.content || null,
              ...(round.toolCalls.length > 0 ? { tool_calls: round.toolCalls } : {}),
            } as ChatCompletionMessageParam;
            return {
              assistantMessage,
              toolCalls: round.toolCalls,
              content: round.content,
              usage: round.usage,
              latencyMs: round.latencyMs,
              raw: round.responseBody,
            };
          }),
        { baseUrl: conn.baseUrl, priority, onRetry: input.onRetry },
      );

  const result = await runToolLoop({
    seed,
    complete: completeWith(input.tools),
    completeFinal: completeWith(undefined),
    callTool: input.callTool,
    onToolCall: input.onToolCall,
    onRound: input.onRound,
    onEmptyRound: input.onEmptyRound,
    compact: input.compact,
    maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
  });

  // A stall that still produced a forced final answer is a degraded success —
  // only an empty answer is a failure. An empty round the provider cut off at
  // the context window (`finish_reason: "length"` — the model spent the whole
  // budget before emitting content or a tool call) is named as such regardless
  // of how the loop ended: "send less" is the fix, not "retry the provider".
  if (!result.content) {
    throw ApiError.serviceUnavailable(
      finishReasonOf(result.responseBody) === "length"
        ? CONTEXT_EXHAUSTED_MESSAGE
        : result.loopDetected
          ? "LLM tool loop stalled without producing a reply"
          : "LLM returned an empty response",
    );
  }

  return {
    content: result.content,
    model: input.model,
    // The loop's last round, which is the response that produced the answer. This
    // used to be dropped on the floor: the loop returned only the requested id, so
    // a reply made with tools recorded a different model name than the identical
    // reply made without them.
    servedModel: servedModelOf(result.responseBody),
    usage: result.usage,
    latencyMs: result.latencyMs,
    requestBody,
    responseBody: result.responseBody,
  };
}
