import "server-only";

import {
  parseScopedRef,
  type InboundMessageEvent,
  type HistoryMessage,
  type SourceId,
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

/**
 * The bot's own label in transcripts. Plain "You" — the assistant's identity
 * is the ASSISTANT's name, asserted by the persona block; the bot account's
 * @username/display name confused the model into answering as its Telegram
 * handle (user decision, 2026-08-24 — departs from the v1 `You (@name)`
 * shape). The account names still drive addressing, never the reply context.
 */
export function botTranscriptLabel(): string {
  return "You";
}

/**
 * Who is speaking in this chat, as far as assistants go. Several can share a
 * group (and the cross-feed makes them talk to each other), so a transcript
 * has to say whose words each assistant line is: the reader's own, or another
 * assistant's, by name.
 */
export interface TranscriptVoices {
  /** The assistant the transcript is being composed FOR; its lines are "You". */
  selfAssistantId?: string | null;
  /** Display names of the assistants that speak here, by id. */
  assistantNames?: ReadonlyMap<string, string>;
}

/**
 * An assistant line whose author is gone from the store, or that predates
 * per-assistant attribution in a chat where somebody else also spoke.
 */
const UNKNOWN_ASSISTANT_LABEL = "Another assistant";

/**
 * The speaker label for an assistant-authored line. Two cases read as the
 * reader's OWN line, which is what they are in every single-assistant chat:
 * an unattributed row (`assistantId` null — mirrored before Phase 3, or by a
 * source that does not track it), and a caller that named no reader at all
 * (nothing to compare against, so claiming somebody else said it would be a
 * guess).
 */
function assistantLabel(
  assistantId: string | null | undefined,
  botLabel: string,
  voices?: TranscriptVoices,
): string {
  if (!assistantId || !voices?.selfAssistantId) return botLabel;
  if (assistantId === voices.selfAssistantId) return botLabel;
  return voices.assistantNames?.get(assistantId) ?? UNKNOWN_ASSISTANT_LABEL;
}

function toLine(entry: HistoryMessage, botLabel: string, voices?: TranscriptVoices): string {
  const label =
    entry.role === "assistant"
      ? assistantLabel(entry.assistantId, botLabel, voices)
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
  options?: { maxMessages?: number; voices?: TranscriptVoices },
): { messages: ChatMessage[]; count: number } {
  const records =
    options?.maxMessages != null && options.maxMessages < history.length
      ? history.slice(history.length - options.maxMessages)
      : [...history];
  if (records.length === 0) return { messages: [], count: 0 };
  const lines = records.map((entry) => toLine(entry, botLabel, options?.voices));
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
  options?: {
    /** The turn's effective text when it differs (a voice transcript). */
    contentOverride?: string;
    voices?: TranscriptVoices;
  },
): { content: string; senderLabel: string | null; data: Record<string, unknown> } {
  const replyTo = event.message.replyTo ?? null;
  const botLabel = botTranscriptLabel();
  // A cross-fed message was written by ANOTHER assistant: the speaker is that
  // assistant by name, not the bot account the source could name.
  const speakerLabel = event.authoredByAssistantId
    ? assistantLabel(event.authoredByAssistantId, botLabel, options?.voices)
    : event.sender.label;
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
    label: speakerLabel,
    replyRef,
    content: options?.contentOverride ?? event.message.content,
  });
  return {
    content,
    senderLabel: speakerLabel,
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
/**
 * Where the conversation is happening, in one sentence. The model used to be
 * told "a Telegram chat" by the base prompt, which became a lie the moment a
 * second source existed — a web thread would confidently place itself in
 * Telegram. One lookup keyed by source id, so a new source app adds a phrase
 * rather than a branch.
 */
const SURFACE: Record<SourceId, { direct: string; group: string }> = {
  tg: {
    direct: "a direct Telegram chat with this person",
    group: "a Telegram group chat",
  },
  chat: {
    direct: "a named thread in this hub's own web chat, typed in a browser",
    group: "a web chat thread",
  },
};

export function surfaceLine(event: InboundMessageEvent): string {
  return `This conversation is ${SURFACE[event.source][event.chat.kind]}.`;
}

export function renderChatContext(
  event: InboundMessageEvent,
): { content: string; data?: Record<string, unknown> } | null {
  const where = surfaceLine(event);
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
    return {
      content: content ? `${where}

${content}` : where,
      data: { memberCount: members.length, source: event.source },
    };
  }
  const content = formatUserContext({
    label: event.sender.label,
    aliases: event.sender.aliases,
  });
  return {
    content: content ? `${where}

${content}` : where,
    data: { source: event.source },
  };
}
