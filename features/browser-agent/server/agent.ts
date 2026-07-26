import "server-only";

import type { LlmConnection, ChatMessage } from "@/server/llm/client";
import {
  chatCompletionWithTools,
  type RoundReport,
  type ToolCallRecord,
  type ToolLoopRound,
} from "@/server/llm/tool-loop";

import { BROWSER_AGENT_TOOLS, makeBrowserToolDispatcher, type AgentToolContext } from "./tools";

/**
 * The browsing agent proper: one goal, run to completion in one session by the
 * configured chat model driving the generic browser toolset over the shared tool
 * loop. Deliberately **unbounded** (recorded decision): no round or wall-clock
 * cap — only the loop's stall guard ends a run that stops progressing, and its
 * forced tools-free final round then salvages a report from what was gathered.
 */

/**
 * Strip tool-call special tokens that leaked into the model's prose. When the
 * loop takes tools away for the forced final answer, a model still "wanting" to
 * act sometimes emits its raw tool-call syntax as literal text
 * (e.g. `<|tool_call>call:browser_navigate{…}<tool_call|>`). That must never
 * reach the chat: remove any angle-bracket token carrying a pipe and any
 * leftover `call:name{…}` body. If nothing readable remains, return "" so the
 * caller falls back to a plain message instead of shipping fragments.
 */
export function sanitizeAgentReport(text: string): string {
  return text
    .replace(/<[^<>]*\|[^<>]*>/g, "")
    .replace(/\bcall:\w+\s*\{[^{}]*\}/gi, "")
    .trim();
}

export interface AgentRunResult {
  report: string;
}

function buildAgentSystemPrompt(isOwner: boolean, requiredLanguage: string | null): string {
  return (
    `You are a web-browsing agent working in the background for a chat bot. ` +
    `You are given a goal and a set of browser tools. Accomplish the goal by ` +
    `navigating the web step by step, then write a final report.\n\n` +
    `Rules:\n` +
    `- Start with browser_navigate when the goal gives you a URL, and with browser_search ` +
    `when it does not — never guess a URL you were not given. After each action you get the page text plus a ` +
    `numbered list of interactive elements — each link shows its destination URL after "->". ` +
    `Click or type using the ref numbers.\n` +
    `- Refs are re-assigned on every action: always use refs from the LATEST page state.\n` +
    `- Check an element's "-> URL" before clicking, and avoid links that leave the ` +
    `site's domain unless they clearly serve the goal.\n` +
    `- Take the fewest steps needed. Do not loop or repeat the same action.\n` +
    (isOwner
      ? ""
      : `- Downloads are disabled for this run (only the owner can download files) — never promise a file.\n`) +
    `- When you have achieved the goal (or determined it cannot be done), STOP calling tools ` +
    `and reply with a clear, concise report of what you found or did. ` +
    (requiredLanguage ? `Write the report in this required language: ${requiredLanguage}. ` : "") +
    `That reply is sent to the chat. Do not include raw HTML or tool syntax.`
  );
}

export interface RunAgentParams {
  goal: string;
  /** LLM connection + model (the configured chat model). */
  conn: LlmConnection;
  model: string;
  /** Everything the browser tools act through for this run. */
  toolContext: AgentToolContext;
  /** Reply language required for the destination chat, or null for the default. */
  requiredLanguage: string | null;
  /** Trace hooks, forwarded to the shared loop. */
  onRequest?: (requestBody: unknown) => void | Promise<void>;
  onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
  onRound?: (round: ToolLoopRound, report: RoundReport) => void | Promise<void>;
}

/**
 * Run one browsing goal to completion. Throws on provider/config failure (the
 * runner records it and fails the run); a stall degrades to a forced report.
 */
export async function runBrowserAgent(params: RunAgentParams): Promise<AgentRunResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(params.toolContext.isOwner, params.requiredLanguage),
    },
    { role: "user", content: `Goal: ${params.goal}` },
  ];

  const result = await chatCompletionWithTools(params.conn, {
    model: params.model,
    messages,
    tools: BROWSER_AGENT_TOOLS,
    callTool: makeBrowserToolDispatcher(params.toolContext),
    onRequest: params.onRequest,
    onToolCall: params.onToolCall,
    onRound: params.onRound,
    // Unbounded by decision — the stall guard is the only stop.
    maxRounds: Number.POSITIVE_INFINITY,
  });

  // A stall that still produced a forced report is indistinguishable from a
  // clean finish here, deliberately — the report is what the chat gets either way.
  return { report: sanitizeAgentReport(result.content) };
}
