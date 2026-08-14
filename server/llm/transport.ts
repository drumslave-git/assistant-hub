import "server-only";

import {
  dynamicTool,
  generateText,
  jsonSchema,
  type ModelMessage,
  type ProviderMetadata,
  type ToolSet,
} from "ai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { toLlmBackendId } from "@/lib/llm-backend";

import { adapterFor } from "./backends";
import type { ReasoningMode } from "./backends";
import type { ChatContentPart, ChatUsage, LlmConnection } from "./client";
import { createProvider, providerOptionsName } from "./provider";

/**
 * The single wire between this app and whichever inference server is configured.
 *
 * One transport, one place where a request is built and a response is read —
 * which is the point of routing through the AI SDK rather than talking to each
 * server on its own terms. The per-backend differences it cannot know about
 * (which knob stops a thinking model, where the thinking text lands) come from
 * `./backends`, and reach the wire through `providerOptions`: the provider
 * spreads that entry into the request body, keeping only the four options it
 * types itself and passing every other key through verbatim.
 *
 * The conversation is held in OpenAI's message shape rather than the SDK's.
 * That is deliberate: `./tool-loop` owns the conversation and appends assistant
 * turns to it verbatim across rounds, so the shape it accumulates is a stable
 * internal DTO. Converting once at this boundary keeps the loop, the browser
 * agent, and the MCP tool bridge untouched by the transport swap.
 */

/**
 * Vendor extras a provider attaches to a tool call and requires echoed back
 * verbatim when that call is replayed in the conversation.
 *
 * Google is the one that makes this mandatory. Gemini signs every `functionCall`
 * it emits, and a follow-up request whose history replays the call without its
 * signature is rejected outright — `Function call is missing a thought_signature
 * in functionCall parts` (400 INVALID_ARGUMENT). That kills the **whole turn**,
 * not the round: on a tool-using bot the first tool call is always followed by
 * another request carrying it, so every reply that touches a tool fails.
 *
 * The loop's conversation is the OpenAI wire shape, so the extras are kept
 * exactly where that wire carries them — `extra_content` on the tool call, which
 * is what Google's OpenAI-compatibility layer emits and expects back.
 */
export interface ToolCallExtraContent {
  google?: { thought_signature?: string };
}

/**
 * A tool call as the loop passes it around: OpenAI's shape plus the vendor
 * extras above. Structurally a `ChatCompletionMessageToolCall` everywhere the
 * loop reads `id`/`function`, so nothing downstream had to learn about this.
 */
export type LoopToolCall = ChatCompletionMessageToolCall & {
  extra_content?: ToolCallExtraContent;
};

/** What one model round produced, in the shape the tool loop already speaks. */
export interface TransportRound {
  content: string;
  toolCalls: LoopToolCall[];
  usage?: ChatUsage;
  latencyMs: number;
  /** Exact body sent to the endpoint, for the trace. */
  requestBody: unknown;
  /** Raw provider response, for the trace. */
  responseBody: unknown;
  finishReason: string;
  /** The model the provider said it served, when it said anything. */
  servedModel?: string;
}

export interface TransportInput {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  maxTokens?: number;
  /** What to ask of a thinking model; the adapter decides how to say it. */
  reasoning?: ReasoningMode;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

/** Text of an OpenAI content field, flattening the multimodal part array. */
function partsToText(content: string | ChatContentPart[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** One SDK content part a user turn may carry. */
type UserPart = { type: "text"; text: string } | { type: "image"; image: URL };

/** A user turn's content, carrying image parts through as SDK image parts. */
function toUserContent(content: unknown): string | UserPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content as ChatContentPart[];
  return parts.flatMap((part): UserPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "image_url") {
      return [{ type: "image", image: new URL(part.image_url.url) }];
    }
    // Audio parts ride the chat model on backends that accept them; the SDK has
    // no `input_audio` part, so the turn keeps its text and the audio is dropped
    // here rather than silently mangled into an image.
    return [];
  });
}

/**
 * Convert the accumulated OpenAI-shaped conversation into SDK messages.
 *
 * Tool turns are the part that matters: an assistant message carrying
 * `tool_calls` becomes an assistant message with `tool-call` parts, and each
 * `role: "tool"` reply becomes a `tool` message with a matching `tool-result`
 * part. Losing the pairing would break the loop's second round on every backend
 * at once, so the `toolCallId`s are carried through untouched.
 */
export function toModelMessages(messages: ChatCompletionMessageParam[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  /** `tool_call_id` → tool name, so a tool result can name the call it answers. */
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: partsToText(message.content as string) });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: toUserContent(message.content) } as ModelMessage);
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.tool_calls ?? [];
      const text = partsToText(message.content as string | null);
      if (calls.length === 0) {
        out.push({ role: "assistant", content: text });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (text) parts.push({ type: "text", text });
      for (const call of calls as LoopToolCall[]) {
        if (call.type !== "function") continue;
        toolNames.set(call.id, call.function.name);
        // The signature the model signed this call with, handed back the only
        // way the provider reads it: `providerOptions.google` on the part, which
        // it re-serializes as `extra_content` on the wire. Absent for every
        // backend that does not sign — nothing is invented here, only replayed.
        const signature = call.extra_content?.google?.thought_signature;
        parts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          input: safeParseJson(call.function.arguments),
          ...(signature ? { providerOptions: { google: { thoughtSignature: signature } } } : {}),
        });
      }
      out.push({ role: "assistant", content: parts } as unknown as ModelMessage);
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id,
            toolName: toolNames.get(message.tool_call_id) ?? "tool",
            output: { type: "text", value: partsToText(message.content as string) },
          },
        ],
      } as unknown as ModelMessage);
    }
  }
  return out;
}

/**
 * The thought signature a provider attached to a tool call, whatever key it
 * filed the metadata under.
 *
 * The two halves of the SDK disagree on that key: the response reader files the
 * signature under the *provider's own name* (`llm` here — what
 * `createOpenAICompatible` was constructed with), while the request builder only
 * ever looks under `google`. Scanning the entries is what bridges them; naming
 * one key would tie this to the provider's current name and regress silently
 * back to the 400 if it ever changed.
 */
function thoughtSignatureOf(metadata: ProviderMetadata | undefined): string | undefined {
  for (const entry of Object.values(metadata ?? {})) {
    const value = (entry as { thoughtSignature?: unknown }).thoughtSignature;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Parse tool-call arguments, falling back to `{}` — never throwing mid-round. */
function safeParseJson(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Bridge MCP tool definitions to the SDK. `dynamicTool` is the right kind here:
 * the schemas are known only at runtime (they come from the MCP servers), and
 * none of them carry an `execute` — the loop runs the tool itself and appends
 * the result, so the model round must *stop* at the call.
 */
export function toToolSet(tools: ChatCompletionTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const entry of tools) {
    if (entry.type !== "function") continue;
    set[entry.function.name] = dynamicTool({
      description: entry.function.description ?? "",
      inputSchema: jsonSchema((entry.function.parameters ?? { type: "object" }) as never),
    });
  }
  return set;
}

/** Normalized usage from the SDK's token counts. */
function toUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): ChatUsage | undefined {
  if (usage.inputTokens == null && usage.outputTokens == null && usage.totalTokens == null) {
    return undefined;
  }
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

/**
 * Run one model round against `conn`.
 *
 * Bounded by `timeoutMs` and never retried here: retry and the priority gate
 * belong to the caller (`./client`), which owns what a failed attempt means.
 */
export async function completeRound(
  conn: LlmConnection,
  input: TransportInput,
): Promise<TransportRound> {
  const adapter = adapterFor(toLlmBackendId(conn.backend));
  const provider = createProvider(conn);

  const extras = adapter.chatBodyExtras({ reasoning: input.reasoning });
  // Where a turn may sit is the server's rule, not the caller's: a backend that
  // constrains it rearranges here, once, for every path that sends a message.
  const messages = adapter.normalizeMessages?.(input.messages) ?? input.messages;
  const start = Date.now();
  const result = await generateText({
    model: provider.languageModel(input.model),
    messages: toModelMessages(messages),
    // The SDK rejects `system` turns inside `messages` by default, steering
    // callers to its single `instructions` field. That does not fit this app:
    // the reply prompt places system turns *between* other turns on purpose —
    // the time context sits after the history window, and the language
    // directive last of all, at maximum recency so it outranks the language of
    // the message, the history, and the persona. Collapsing them into one
    // leading block would silently change what the model weighs most.
    allowSystemInMessages: true,
    ...(input.tools ? { tools: toToolSet(input.tools) } : {}),
    ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
    // One round per call: the loop decides whether there is another, because it
    // owns the stall guard, the compaction, and the forced tools-free finish.
    stopWhen: () => true,
    timeout: input.timeoutMs,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    // Retries live in `./client` alongside the priority gate, so the SDK's own
    // are off — two retry layers would multiply into a wait nobody chose.
    maxRetries: 0,
    // Keyed per connection: the shared `llm` name for OpenAI-compatible
    // providers, the SDK-fixed `anthropic` for the native one.
    ...(Object.keys(extras).length > 0
      ? { providerOptions: { [providerOptionsName(conn)]: extras } }
      : {}),
    // Off by default in the SDK; the Debug pages require the complete bodies.
    include: { requestBody: true, requestMessages: true, responseBody: true },
  });
  const latencyMs = Date.now() - start;

  const toolCalls: LoopToolCall[] = result.toolCalls.map((call) => {
    const signature = thoughtSignatureOf(call.providerMetadata);
    return {
      id: call.toolCallId,
      type: "function",
      function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
      // Kept on the call, not beside it: the loop appends this object to the
      // conversation and re-sends it every following round, so the signature has
      // to travel with the call it belongs to — see {@link ToolCallExtraContent}.
      ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}),
    };
  });

  return {
    content: result.text.trim(),
    toolCalls,
    usage: toUsage(result.usage),
    latencyMs,
    requestBody: result.request?.body,
    responseBody: result.response?.body,
    finishReason: result.finishReason,
    ...(result.response?.modelId ? { servedModel: result.response.modelId } : {}),
  };
}
