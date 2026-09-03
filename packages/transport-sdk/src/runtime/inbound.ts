import {
  messageDedupeKey,
  scopedRef,
  transportMessageEventSchema,
  turnCorrelationId,
  type TransportMessageEvent,
  type TransportReceiver,
  type TransportUpdateEvent,
} from "@assistant-hub-swarm/contracts";

import { updateEnvelope, type SeenCache } from "./updates";
import type {
  AddressingRule,
  BotIdentity,
  InboundMessage,
  TransportDescriptor,
} from "./types";

/**
 * Turning one normalized message into the event the core consumes: the
 * dedupe key, the shared-chat suppression, the per-connection addressing
 * verdicts, and the envelope.
 *
 * None of this is platform judgement — it is the contract's own shape, and
 * every transport had a copy of it. What stays with the transport is the
 * normalizer that produced the {@link InboundMessage} and the addressing
 * rule applied below.
 */

export type InboundResult =
  | { status: "forwarded"; event: TransportMessageEvent }
  | { status: "duplicate"; presence: TransportUpdateEvent }
  | { status: "skipped"; reason: "no_content" };

export function buildInboundEvent<TRaw>(input: {
  descriptor: TransportDescriptor;
  raw: TRaw;
  message: InboundMessage;
  addressing: AddressingRule<TRaw>;
  /** The connection that received it. */
  receivedBy: string;
  /** Every connection running right now, for the receivers list. */
  running: readonly (BotIdentity & { assistantId: string })[];
  seen: SeenCache;
}): InboundResult {
  const { descriptor, message } = input;
  const source = descriptor.id;

  if (!message.content.trim() && !message.media) {
    return { status: "skipped", reason: "no_content" };
  }

  const dedupeKey = messageDedupeKey({
    chatId: message.chatId,
    sourceMessageId: message.sourceMessageId,
    // A shared chat is one stream; a direct one is per assistant.
    assistantId: message.direct ? input.receivedBy : null,
  });

  if (!message.direct && !input.seen.first(`m:${source}:${dedupeKey}`)) {
    // Not this connection's to forward, but its presence in the chat is
    // exactly what the core resolves an audience from.
    return {
      status: "duplicate",
      presence: {
        ...updateEnvelope(`presence:${message.chatId}:${input.receivedBy}`),
        type: "transport.presence",
        source,
        chatId: message.chatId,
        assistantId: input.receivedBy,
      },
    };
  }

  // The structural verdict per running connection — judged against each
  // receiver's own bot account. A direct chat lists the receiving connection
  // alone: one person, one bot.
  const connections = message.direct
    ? input.running.filter((c) => c.assistantId === input.receivedBy)
    : input.running;
  const receivers: TransportReceiver[] = connections.map((connection) => ({
    assistantId: connection.assistantId,
    identity: connection.identity,
    addressing: input.addressing(input.raw, connection),
  }));

  const replyAuthorAssistant = message.replyTo?.authorPlatformId
    ? (input.running.find((c) => c.id === message.replyTo!.authorPlatformId)?.assistantId ?? null)
    : null;

  const event = transportMessageEventSchema.parse({
    ...updateEnvelope(
      turnCorrelationId(scopedRef(source, "chat", message.chatId), message.sourceMessageId),
    ),
    type: "transport.message",
    source,
    receivedBy: input.receivedBy,
    chat: {
      id: message.chatId,
      kind: message.direct ? "direct" : "group",
      title: message.chatTitle ?? null,
      type: message.chatType ?? null,
    },
    sender: message.sender,
    message: {
      sourceMessageId: message.sourceMessageId,
      content: message.content,
      sentAt: message.sentAt,
      threadId: message.threadId ?? null,
      replyTo: message.replyTo
        ? {
            sourceMessageId: message.replyTo.sourceMessageId,
            hasMedia: message.replyTo.hasMedia,
            text: message.replyTo.text,
            quote: message.replyTo.quote ?? null,
            author: message.replyTo.author,
            authorAssistantId: replyAuthorAssistant,
          }
        : null,
    },
    media: message.media ?? null,
    receivers,
    dedupeKey,
  } satisfies TransportMessageEvent);

  return { status: "forwarded", event };
}

/** An edit, in the contract's shape. */
export function buildEditEvent(input: {
  descriptor: TransportDescriptor;
  assistantId: string;
  chatId: string;
  direct: boolean;
  sourceMessageId: string;
  content: string;
  editedAt: string;
}): TransportUpdateEvent {
  const source = input.descriptor.id;
  return {
    ...updateEnvelope(
      turnCorrelationId(scopedRef(source, "chat", input.chatId), input.sourceMessageId),
    ),
    type: "transport.edited",
    source,
    chat: { id: input.chatId, kind: input.direct ? "direct" : "group" },
    assistantId: input.assistantId,
    sourceMessageId: input.sourceMessageId,
    content: input.content,
    editedAt: input.editedAt,
  };
}

/** A reaction on one of this assistant's messages — the feedback seam. */
export function buildReactionEvent(input: {
  descriptor: TransportDescriptor;
  assistantId: string;
  chatId: string;
  direct: boolean;
  sourceMessageId: string;
  reaction: "up" | "down";
  user: TransportMessageEvent["sender"];
}): TransportUpdateEvent {
  const source = input.descriptor.id;
  return {
    ...updateEnvelope(
      turnCorrelationId(scopedRef(source, "chat", input.chatId), input.sourceMessageId),
    ),
    type: "transport.reaction",
    source,
    chat: { id: input.chatId, kind: input.direct ? "direct" : "group" },
    assistantId: input.assistantId,
    sourceMessageId: input.sourceMessageId,
    reaction: input.reaction,
    user: input.user,
  };
}
