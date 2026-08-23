import "server-only";

import {
  parseScopedRef,
  type InboundMessageEvent,
  type HistoryMessage,
} from "@assistant-hub/contracts";

import {
  TRANSCRIPT_PREAMBLE,
  botReactionSuffix,
  fallbackSpeakerLabel,
  renderTranscriptLine,
  type ReplyRef,
} from "@/features/history/server/format";
import { formatGroupContext } from "@/features/known-groups/format";
import { formatUserContext } from "@/features/known-users/format";
import type { ChatMessage } from "@/server/llm/client";

/**
 * Prompt blocks composed from an inbound event's conversation context — the
 * queue-consumer counterparts of the v1 loaders that read the database
 * (`getConversationWindow`, `composeCurrentTurn`, `getGroupContext`,
 * `getUserContext`). The rendering primitives are the same modules the v1
 * path uses, so the transcript format — id anchors, labels, reply markers,
 * media suffixes, reaction badges — stays byte-identical; only where the
 * data comes from changed (the source supplies it, per the contract).
 */

/** The bot's own label in transcripts, matching the v1 shape. */
export function botTranscriptLabel(botUsername: string): string {
  return `You (@${botUsername})`;
}

function toLine(entry: HistoryMessage, botLabel: string): string {
  const label =
    entry.role === "assistant"
      ? botLabel
      : (entry.senderLabel ??
        fallbackSpeakerLabel(entry.senderRef ? parseScopedRef(entry.senderRef).id : null));
  const replyRef: ReplyRef | null =
    entry.replyToSourceMessageId != null
      ? { kind: "anchor", telegramMessageId: Number(entry.replyToSourceMessageId) }
      : null;
  const line = renderTranscriptLine({
    telegramMessageId: Number(entry.sourceMessageId),
    label,
    replyRef,
    content: entry.content,
  });
  return line + (entry.mediaNote ?? "") + botReactionSuffix({ botReaction: entry.botReaction ?? null });
}

/**
 * The recent-history window as one transcript message (the v1
 * `ConversationWindow` shape). `maxMessages` keeps the newest N — the
 * context-overflow retry re-renders progressively smaller until the request
 * fits, trimming locally since the full window is on the event.
 */
export function renderHistoryWindow(
  history: readonly HistoryMessage[],
  botLabel: string,
  options?: { maxMessages?: number },
): { messages: ChatMessage[]; count: number } {
  const records =
    options?.maxMessages != null && options.maxMessages < history.length
      ? history.slice(history.length - options.maxMessages)
      : [...history];
  if (records.length === 0) return { messages: [], count: 0 };
  const lines = records.map((entry) => toLine(entry, botLabel));
  return {
    messages: [{ role: "user", content: `${TRANSCRIPT_PREAMBLE}\n\n${lines.join("\n")}` }],
    count: records.length,
  };
}

/**
 * The current turn as a transcript line (the v1 `composeCurrentTurn` shape):
 * a stored reply target becomes a dereferenceable `[reply to #<id>]` anchor,
 * an unstored one gets its sender and full text inlined, never trimmed.
 */
export function renderCurrentTurn(
  event: InboundMessageEvent,
): { content: string; senderLabel: string | null; data: Record<string, unknown> } {
  const replyTo = event.message.replyTo ?? null;
  const botLabel = botTranscriptLabel(event.connection.botUsername);
  let replyRef: ReplyRef | null = null;
  if (replyTo) {
    replyRef = replyTo.stored
      ? {
          kind: "anchor",
          telegramMessageId: Number(replyTo.sourceMessageId),
          quote: replyTo.quote ?? null,
        }
      : {
          kind: "inline",
          label: replyTo.fromAssistant ? botLabel : replyTo.senderLabel,
          text: replyTo.text,
        };
  }
  const content = renderTranscriptLine({
    telegramMessageId: Number(event.message.sourceMessageId),
    label: event.sender.label,
    replyRef,
    content: event.message.content,
  });
  return {
    content,
    senderLabel: event.sender.label,
    data: {
      line: content,
      replyTo: replyTo
        ? { telegramMessageId: Number(replyTo.sourceMessageId), resolved: replyRef?.kind ?? null }
        : null,
    },
  };
}

/**
 * The chat-identity block (the v1 `getGroupContext` / `getUserContext`
 * shapes): in a group, the roster of known participants plus operator notes;
 * in a direct chat, who the bot is talking to and their known names.
 */
export function renderChatContext(
  event: InboundMessageEvent,
): { content: string; data?: Record<string, unknown> } | null {
  if (event.chat.kind === "group") {
    const members = event.context.participants.map((participant) => ({
      userId: parseScopedRef(participant.ref).id,
      label: participant.label,
      aliases: participant.aliases,
    }));
    const content = formatGroupContext({
      title: event.chat.title ?? null,
      notes: event.chat.notes ?? null,
      members,
    });
    return content ? { content, data: { memberCount: members.length } } : null;
  }
  const content = formatUserContext({
    label: event.sender.label,
    aliases: event.sender.aliases,
  });
  return { content };
}
