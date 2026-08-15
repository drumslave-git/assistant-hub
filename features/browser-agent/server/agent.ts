import "server-only";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { LlmCallTrace, LlmConnection, ChatMessage } from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";

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

/**
 * Browser tools whose result is a page-state snapshot (URL + page text +
 * interactive elements). Refs are re-assigned on every action, so every snapshot
 * but the latest is unusable by the agent's own rules — carrying them verbatim
 * is what let a run's prompt grow monotonically until it overflowed the context
 * window (2026-07-30 trace: 32k window spent, run died with the download URL
 * already found).
 */
const PAGE_STATE_TOOLS = new Set([
  "browser_navigate",
  "browser_back",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_read",
  "browser_wait",
]);

/** Raw-source chunks kept verbatim; a URL hunt reads adjacent chunks together. */
const SOURCE_CHUNKS_KEPT = 2;

const STALE_PAGE_STATE_STUB =
  "[superseded page state removed — its refs are stale; the latest page state is the current one. Call browser_read if you need the page again.]";
const STALE_SOURCE_STUB =
  "[superseded page-source chunk removed — call browser_source again if you still need it.]";
const STALE_SCREENSHOT_STUB =
  "[superseded screenshot removed — call browser_screenshot again if you need a current one.]";

/**
 * The per-round conversation rewrite for a browsing run: every page-state
 * snapshot but the latest, every raw-source chunk but the latest
 * {@link SOURCE_CHUNKS_KEPT}, and every tool-produced screenshot turn but the
 * latest are replaced with a one-line stub telling the model how to re-fetch.
 * Search results, network listings, and download outcomes are kept — they are
 * small and carry durable URLs the model acts on rounds later. Applied to what
 * each round sends, never to the kept history (see `RunToolLoopParams.compact`).
 */
export function compactAgentConversation(
  conversation: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // tool_call_id → tool name, from the assistant turns that requested the calls.
  const toolNameById = new Map<string, string>();
  for (const message of conversation) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.type === "function") toolNameById.set(call.id, call.function.name);
    }
  }

  const nameAt = (message: ChatCompletionMessageParam): string | undefined =>
    message.role === "tool" ? toolNameById.get(message.tool_call_id) : undefined;
  const isImageTurn = (message: ChatCompletionMessageParam): boolean =>
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url");

  let lastPageState = -1;
  const sourceChunks: number[] = [];
  let lastImageTurn = -1;
  conversation.forEach((message, index) => {
    const name = nameAt(message);
    if (name && PAGE_STATE_TOOLS.has(name)) lastPageState = index;
    if (name === "browser_source") sourceChunks.push(index);
    if (isImageTurn(message)) lastImageTurn = index;
  });
  const keptSourceChunks = new Set(sourceChunks.slice(-SOURCE_CHUNKS_KEPT));

  return conversation.map((message, index) => {
    const name = nameAt(message);
    if (name && PAGE_STATE_TOOLS.has(name) && index !== lastPageState) {
      return { ...message, content: STALE_PAGE_STATE_STUB };
    }
    if (name === "browser_source" && !keptSourceChunks.has(index)) {
      return { ...message, content: STALE_SOURCE_STUB };
    }
    if (isImageTurn(message) && index !== lastImageTurn) {
      return { role: "user", content: STALE_SCREENSHOT_STUB };
    }
    return message;
  });
}

function buildAgentSystemPrompt(
  toolContext: AgentToolContext,
  requiredLanguage: string | null,
): string {
  const { isOwner } = toolContext;
  const urlFenced = toolContext.allowedDownloadUrls !== null;
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
      ? // The download rules are stated here as well as in the tool descriptions,
        // because the failure they address is a *decision* the agent makes before
        // it ever looks at a tool: on 2026-07-28 a run asked to download a track
        // reported back that the site has no download button and the owner should
        // use yt-dlp themselves, having never called a download tool at all.
        `- You CAN download files, and you are expected to. If the goal asks for a file, ` +
        `song, track, video or document, the run is not done until you have called a ` +
        `download tool. Never finish by telling the user how to download it themselves, ` +
        `naming a program for them to run, or pointing them at another site — either ` +
        `download it, or say exactly which tool you called and how it failed.\n` +
        `- On a video or music site (YouTube, YouTube Music, SoundCloud, Vimeo, TikTok, ` +
        `Bandcamp, a podcast page …), download with browser_download_media and the page ` +
        `URL — use mode "audio" for a song/track/podcast and "video" for a video. Those ` +
        `pages never expose a media file URL, so do not START by reading the source or ` +
        `the network looking for one, and do not conclude the download is impossible ` +
        `without having called browser_download_media.\n` +
        // One failed tool call is not a failed run (operator report, 2026-08-12:
        // a yt-dlp failure ended the run with no other route even attempted).
        // The escape hatch is scoped to the SAME content — the substitution
        // guard below still forbids delivering anything else.
        `- A failed download tool is not yet a failed run: before giving up, try the other ` +
        `routes to the SAME content. If browser_download_media fails, re-check you gave it ` +
        `the exact page URL (the verbatim URLs list wins over the goal text) and try once ` +
        `more; look for another official page of the very same content and try that. Once ` +
        `browser_download_media has actually failed, you may also open the page, play the ` +
        `media, and check browser_get_network for a direct media URL — many sites serve ` +
        `the video as a plain .mp4 (browser_download_file) or a .m3u8 stream ` +
        `(browser_download_stream). Only when those are exhausted has the run failed — ` +
        `then stop and report exactly what you tried and how each attempt failed.\n` +
        // Substitution guard (incident, 2026-08-01): a run that could not reach
        // the asked-for tweet searched up an unrelated music video and delivered
        // it as "similar". A failed goal must come back as a failure.
        `- Download ONLY what the goal names. NEVER download different or "similar" content ` +
        `as a substitute — not even if the goal seems to offer that option, and no matter ` +
        `how many attempts failed. A substitute file is a wrong result; an honest failure ` +
        `report is the correct one.\n` +
        (urlFenced
          ? `- This run may only download from the user's own link(s), listed under "URLs" ` +
            `in the goal message. A file too large to send to the chat cannot be delivered ` +
            `at all — if a download tool reports that, relay it as the outcome and never ` +
            `mention any server folder.\n`
          : "")
      : `- Downloads are disabled for this run (only the owner can download files) — never promise a file.\n`) +
    `- When you have achieved the goal (or determined it cannot be done), STOP calling tools ` +
    `and reply with a clear, concise report of what you found or did. ` +
    (requiredLanguage ? `Write the report in this required language: ${requiredLanguage}. ` : "") +
    `That reply is sent to the chat. Do not include raw HTML or tool syntax.`
  );
}

export interface RunAgentParams {
  goal: string;
  /**
   * The triggering message's URLs, extracted in code — appended to the goal
   * verbatim so the agent works from exact links even when the goal text (which
   * an LLM composed) mis-typed one. Empty → the goal stands alone.
   */
  sourceUrls?: string[];
  /** LLM connection + model (the configured chat model). */
  conn: LlmConnection;
  model: string;
  /** Everything the browser tools act through for this run. */
  toolContext: AgentToolContext;
  /** Reply language required for the destination chat, or null for the default. */
  requiredLanguage: string | null;
  /** Recording options for the shared LLM tracing layer, forwarded to the loop. */
  trace?: LlmCallTrace;
}

/**
 * The user turn: the goal, then — when the triggering message carried links —
 * those links verbatim. The goal text passed through an LLM, which has mis-typed
 * a URL before (2026-08-01: one flipped digit in a tweet id sent a run chasing a
 * nonexistent post); the code-extracted list is the authority.
 */
export function buildGoalMessage(goal: string, sourceUrls: string[]): string {
  if (sourceUrls.length === 0) return `Goal: ${goal}`;
  const list = sourceUrls.map((url, i) => `${i + 1}. ${url}`).join("\n");
  return (
    `Goal: ${goal}\n\n` +
    `URLs from the user's message, copied verbatim by the system:\n${list}\n` +
    `These are exact, character for character. If a URL in the goal text above differs, ` +
    `the goal mis-typed it — use the URLs from this list.`
  );
}

/**
 * Run one browsing goal to completion. Throws on provider/config failure (the
 * runner records it and fails the run); a stall degrades to a forced report.
 */
export async function runBrowserAgent(params: RunAgentParams): Promise<AgentRunResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(params.toolContext, params.requiredLanguage),
    },
    { role: "user", content: buildGoalMessage(params.goal, params.sourceUrls ?? []) },
  ];

  const result = await chatCompletionWithTools(params.conn, {
    model: params.model,
    messages,
    tools: BROWSER_AGENT_TOOLS,
    callTool: makeBrowserToolDispatcher(params.toolContext),
    ...(params.trace ? { trace: params.trace } : {}),
    compact: compactAgentConversation,
    // Unbounded by decision — the stall guard is the only stop.
    maxRounds: Number.POSITIVE_INFINITY,
  });

  // A stall that still produced a forced report is indistinguishable from a
  // clean finish here, deliberately — the report is what the chat gets either way.
  return { report: sanitizeAgentReport(result.content) };
}
