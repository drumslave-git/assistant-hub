import {
  messageDedupeKey,
  type MessageDeliveredEvent,
} from "@assistant-hub-swarm/contracts";

import { runningRoster, type AssistantConnection } from "./connections";
import type { TgOutbound } from "./outbound";
import { splitMessage } from "./split";
import { updateEnvelope, type UpdatePublisher } from "./updates";

/**
 * Sending text into a Telegram chat, as one assistant: the split under
 * Telegram's cap, each send, and the `message.delivered` event per part that
 * the core's ingest mirrors and cross-feeds. One function because there are
 * three callers who must not drift apart: the reply-delivery consumer, the
 * internal REST API and this app's MCP delivery tools.
 *
 * The core hands over the whole answer and knows no platform's cap (user
 * decision, 2026-09-02): a long text becomes several messages here, every
 * part attached to the same reply target and reported on its own, so the
 * mirror holds all of it.
 *
 * `#id` links: the whitelist arrives from the CORE (it owns the mirror since
 * Phase 7) — callers pass what the reply-delivery event or the send request
 * carried; nothing is resolved here.
 */

export interface SendDeps {
  sender: Pick<TgOutbound, "sendMessage">;
  publisher: UpdatePublisher;
  running: () => AssistantConnection[];
  /**
   * Called when a delivered report could not be published — the message is
   * in the chat regardless, so this is for the caller's log or trace.
   * Default: `console.error`.
   */
  onReportFailure?: (messageId: number, error: unknown) => void;
}

export interface SendChatMessageInput {
  chatId: string;
  assistantId: string | null;
  text: string;
  /** What to attach the message to; Telegram may refuse and send it loose. */
  replyToMessageId?: number | null;
  threadId?: number | null;
  silent?: boolean;
  /** Core-resolved whitelist for `#<id>` citation links. */
  linkableMessageIds?: readonly number[];
}

export interface SentChatMessage {
  /** The first message sent — what a later deletion or a reply target names. */
  messageId: number;
  /** What Telegram actually attached to the first part, which is not always what was asked. */
  replyToMessageId: number | null;
  /** Every message the text became, in order — one unless it exceeded the cap. */
  messageIds: number[];
}

/** Whether a telegram chat id names a group (negative ids). */
export function isGroupChat(chatId: string): boolean {
  return chatId.startsWith("-");
}

/** Report one performed delivery to the core (mirror + cross-feed seam). */
export async function publishDelivered(
  deps: Pick<SendDeps, "publisher" | "running">,
  input: {
    chatId: string;
    assistantId: string | null;
    messageId: number;
    content: string;
    replyToMessageId: number | null;
    threadId?: number | null;
    silent?: boolean;
    image?: { fileId: string; fileUniqueId: string | null; base64: string } | null;
  },
): Promise<void> {
  const isGroup = isGroupChat(input.chatId);
  const event: MessageDeliveredEvent = {
    ...updateEnvelope(`${input.chatId}:${input.messageId}`),
    type: "message.delivered",
    source: "tg",
    chat: { id: input.chatId, kind: isGroup ? "group" : "direct" },
    assistantId: input.assistantId,
    sourceMessageId: String(input.messageId),
    dedupeKey: messageDedupeKey({
      chatId: input.chatId,
      sourceMessageId: String(input.messageId),
      assistantId: isGroup ? null : input.assistantId,
    }),
    content: input.content,
    replyToSourceMessageId:
      input.replyToMessageId != null ? String(input.replyToMessageId) : null,
    sentAt: new Date().toISOString(),
    threadId: input.threadId != null ? String(input.threadId) : null,
    silent: input.silent ?? false,
    image: input.image ?? null,
    running: runningRoster(deps.running()),
  };
  await deps.publisher.publish(event);
}

export async function sendChatMessage(
  deps: SendDeps,
  input: SendChatMessageInput,
): Promise<SentChatMessage> {
  const reportFailure =
    deps.onReportFailure ??
    ((messageId: number, err: unknown) =>
      console.error(
        `Failed to report delivery ${input.chatId}:${messageId}:`,
        err instanceof Error ? err.message : String(err),
      ));
  // Empty text is sent as-is: Telegram's refusal is the honest answer, and
  // it reaches the caller as the send error it is.
  const parts = splitMessage(input.text);
  if (parts.length === 0) parts.push(input.text);

  let first: SentChatMessage | null = null;
  const messageIds: number[] = [];
  for (const part of parts) {
    const sent = await deps.sender.sendMessage(input.chatId, part, {
      replyToMessageId: input.replyToMessageId ?? null,
      threadId: input.threadId ?? null,
      silent: input.silent ?? false,
      linkableMessageIds: input.linkableMessageIds ?? [],
    });
    messageIds.push(sent.messageId);
    first ??= { messageId: sent.messageId, replyToMessageId: sent.replyToMessageId, messageIds };

    await publishDelivered(deps, {
      chatId: input.chatId,
      assistantId: input.assistantId,
      messageId: sent.messageId,
      content: part,
      // What is actually in the chat, not what was asked for.
      replyToMessageId: sent.replyToMessageId,
      threadId: input.threadId,
      silent: input.silent,
    }).catch((err) => reportFailure(sent.messageId, err));
  }
  return first!;
}
