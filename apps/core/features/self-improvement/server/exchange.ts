import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";

import { FEATURES } from "@/lib/features";
import type { Trace } from "@/lib/trace";
import { getLatestTraceIdsByCorrelation, getTrace } from "@/server/trace";
import type { UserFeedback } from "../types";
import type { SourceMessagePort } from "./feedback-store";

/**
 * Renders what the bot did, as text an LLM can read back. Two shapes, both fed
 * by the feedback flows:
 *
 *  - {@link renderExchange} — the compact exchange (what was asked, what was
 *    answered, what the user thought of it) that the daily folds read.
 *  - {@link renderReplyTrace} — how that answer was produced (the prompt, the
 *    tools, the reply), read by the self-reflection pass.
 *
 * Kept out of both callers so the reflection and the folds cannot drift apart on
 * what "the exchange" means, and so neither has to import the other.
 */

/**
 * Longest rendered form of a single prompt message. The history window is
 * injected as its own turns, so a day of chatter is many bounded messages rather
 * than one huge one — a cap this size loses nothing on a normal turn while
 * keeping a pathological one (a pasted document) from crowding out the rest.
 */
const MAX_MESSAGE_CHARS = 3_000;

/** Longest rendered form of one tool's arguments or result. */
const MAX_TOOL_CHARS = 1_000;

/**
 * Ceiling on the whole rendered trace. Context discipline (the same requirement
 * the per-feedback folds follow): one reflection call must never be able to
 * overflow the model's context, however long the turn behind it was.
 */
const MAX_TRACE_CHARS = 16_000;

/** Cut `text` to `max`, marking what was dropped so the model knows it is partial. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [+${text.length - max} chars]`;
}

/**
 * The features whose traces *produce* a bot message. The lookup must be scoped
 * to them: a correlation id is shared by every feature that keys a trace on the
 * same message, so an unscoped "latest trace on this message" would sooner
 * return the feedback menu — or the previous reflection, reading itself.
 */
const PRODUCER_FEATURES = [FEATURES["bot-messaging"].id, FEATURES.tasks.id];

/**
 * The trace of the turn that produced a bot message, or null when there is none
 * (an imported message, one from before tracing, or a purged trace).
 *
 * Two ways in, because the two kinds of bot message are keyed differently:
 *
 *  - A **proactive send** (a scheduled-task fire) has no incoming message to key
 *    on, so it settles on what it delivered — found by the message itself.
 *  - A **reply** is keyed by the *incoming* message it answered, so the assistant
 *    row is resolved first and its reply pointer followed.
 *
 * The direct key is tried first — it is one query, and a reply never claims it.
 *
 * Best-effort: any lookup failure resolves null rather than throwing at the
 * caller, which always has a degraded path.
 */
export async function getReplyTrace(
  messages: SourceMessagePort,
  source: SourceId,
  chatId: string,
  sourceMessageId: string,
): Promise<Trace | null> {
  try {
    const direct = await producerTrace(`${chatId}:${sourceMessageId}`);
    if (direct) return direct;

    const replyRow = await messages.getMessage(source, chatId, sourceMessageId);
    const anchor = replyRow?.replyToSourceMessageId;
    if (anchor == null) return null;
    return await producerTrace(`${chatId}:${anchor}`);
  } catch {
    return null;
  }
}

/** The newest message-producing trace on a correlation id, with its events. */
async function producerTrace(correlation: string): Promise<Trace | null> {
  const traceIds = await getLatestTraceIdsByCorrelation([correlation], {
    features: PRODUCER_FEATURES,
  });
  const traceId = traceIds.get(correlation);
  return traceId ? await getTrace(traceId) : null;
}

/**
 * One feedback as a compact exchange block: the user's message, the bot's reply,
 * the reaction, what the user said about it, and — when it has been written — the
 * bot's own reflection on why it went that way. Loaded from the history mirror
 * (the trace's full bodies stay linked for the operator, but the mirror carries
 * the same exchange text without the repeated per-trace boilerplate).
 */
export async function renderExchange(
  messages: SourceMessagePort,
  feedback: UserFeedback,
): Promise<string> {
  const reply = await messages
    .getMessage(feedback.source, feedback.chatId, feedback.sourceMessageId)
    .catch(() => null);
  const asked =
    reply?.replyToSourceMessageId != null
      ? await messages
          .getMessage(feedback.source, feedback.chatId, reply.replyToSourceMessageId)
          .catch(() => null)
      : null;
  const lines = [
    `User message: ${asked?.content?.trim() || "(not available)"}`,
    `Bot reply: ${reply?.content?.trim() || "(not available)"}`,
    `User reaction: ${feedback.reaction === "up" ? "👍 liked it" : "👎 disliked it"}`,
    `User feedback: ${feedback.feedback ?? "(none)"}`,
  ];
  if (feedback.reflection?.trim()) {
    lines.push(`The bot's own reflection on this exchange: ${feedback.reflection.trim()}`);
  }
  return lines.join("\n");
}

/** One prompt message's content as text (image parts become a marker, not bytes). */
function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text") return p.text ?? "";
      if (p?.type === "image_url") return "[image]";
      return JSON.stringify(part);
    })
    .join("\n");
}

/** Compact one-line JSON for a trace payload, clipped. */
function renderJson(value: unknown, max: number): string {
  try {
    return clip(JSON.stringify(value) ?? "null", max);
  } catch {
    return "(unserializable)";
  }
}

/**
 * The messages of the last `llm_request` on a trace. The reply request is
 * recorded after any addressing-analyzer request, so the last one is the prompt
 * that actually produced the reply. Image bytes were already replaced with a
 * marker when the event was recorded.
 */
function promptMessages(trace: Trace): { role?: string; content?: unknown }[] | null {
  for (let i = trace.events.length - 1; i >= 0; i -= 1) {
    const event = trace.events[i];
    if (event.type !== "llm_request") continue;
    const messages = (event.data as { messages?: unknown } | undefined)?.messages;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

/**
 * How a reply was produced, rendered from its trace: the prompt the model was
 * given, the tools it ran with their results, the text it sent, and anything
 * that failed on the way. This is the evidence the reflection reasons over — a
 * reply is rarely bad "because the model is bad", it is bad because of something
 * in this block (a persona instruction, a missing tool result, a stale context).
 *
 * Curated rather than raw: trace events carry operator-facing framing that costs
 * context and teaches the model nothing. Returns null when the trace holds no
 * prompt (nothing useful to reason about).
 */
export function renderReplyTrace(trace: Trace): string | null {
  const messages = promptMessages(trace);
  if (!messages) return null;

  const sections: string[] = [];

  sections.push(
    ["Prompt the bot was given:", ...messages.map(
      (m) => `[${m.role ?? "?"}] ${clip(renderContent(m.content), MAX_MESSAGE_CHARS)}`,
    )].join("\n"),
  );

  const tools = trace.events.filter((e) => e.type === "external_call");
  if (tools.length > 0) {
    sections.push(
      ["Tools the bot ran:", ...tools.map((event) => {
        const data = event.data as { args?: unknown; result?: unknown } | undefined;
        return [
          `- ${event.message}${event.level === "warn" ? " (failed)" : ""}`,
          `  arguments: ${renderJson(data?.args, MAX_TOOL_CHARS)}`,
          `  result: ${renderJson(data?.result, MAX_TOOL_CHARS)}`,
        ].join("\n");
      })].join("\n"),
    );
  }

  const sent = trace.events.find((e) => e.type === "output" && e.level === "success");
  const sentContent = (sent?.data as { content?: unknown } | undefined)?.content;
  if (typeof sentContent === "string") {
    sections.push(`Reply the bot sent:\n${clip(sentContent, MAX_MESSAGE_CHARS)}`);
  }

  const failures = trace.events.filter((e) => e.type === "error" || e.level === "error");
  if (failures.length > 0) {
    sections.push(
      ["Failures recorded while producing the reply:", ...failures.map(
        (event) => `- ${event.message}: ${renderJson(event.data, MAX_TOOL_CHARS)}`,
      )].join("\n"),
    );
  }

  return clip(sections.join("\n\n"), MAX_TRACE_CHARS);
}
