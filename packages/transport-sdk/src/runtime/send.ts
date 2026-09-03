import {
  messageDedupeKey,
  scopedRef,
  turnCorrelationId,
  type MessageDeliveredEvent,
} from "@assistant-hub-swarm/contracts";

import { splitMessage } from "./split";
import { updateEnvelope, type UpdatePublisher } from "./updates";
import type { ConnectionStatus, PlatformConnection, SendOptions, TransportDescriptor } from "./types";

/**
 * The one send, for every transport: split under the platform's cap, send
 * each part, and report each as its own `message.delivered` — which is what
 * the core mirrors and cross-feeds off.
 *
 * One function because there are three callers who must not drift apart: the
 * reply-delivery consumer, the internal REST API and the MCP delivery tools.
 * Each transport used to own its own copy of that rule, which is three ways
 * for the same bug to appear per platform.
 */

/** The roster a delivered event carries, for the core's cross-feed. */
export interface RunningConnection {
  assistantId: string;
  botId: string;
  identity: { botUsername: string; botDisplayName: string };
}

export interface SendContext {
  descriptor: TransportDescriptor;
  publisher: UpdatePublisher;
  running: () => RunningConnection[];
  /** The connection to send through, for one assistant. */
  connectionFor: (assistantId: string | null) => PlatformConnection;
  /** Called when a delivered report could not be published; the send stands. */
  onReportFailure?: (sourceMessageId: string, error: unknown) => void;
}

export interface SendInput extends SendOptions {
  chatId: string;
  assistantId: string | null;
  text: string;
  /** Whether the chat is direct; decides the dedupe stream. */
  direct: boolean;
}

export interface SentChatMessage {
  /** The first message sent — what a later deletion or reply target names. */
  sourceMessageId: string;
  /** What the platform actually attached to the first part. */
  replyToSourceMessageId: string | null;
  /** Every message the text became, in order. */
  sourceMessageIds: string[];
}

/** Report one performed delivery to the core (mirror + cross-feed seam). */
export async function publishDelivered(
  ctx: Pick<SendContext, "descriptor" | "publisher" | "running">,
  input: {
    chatId: string;
    assistantId: string | null;
    sourceMessageId: string;
    content: string;
    direct: boolean;
    replyToSourceMessageId: string | null;
    threadId?: string | null;
    silent?: boolean;
    image?: { fileId: string; fileUniqueId: string | null; base64: string } | null;
  },
): Promise<void> {
  const source = ctx.descriptor.id;
  const event: MessageDeliveredEvent = {
    ...updateEnvelope(
      turnCorrelationId(scopedRef(source, "chat", input.chatId), input.sourceMessageId),
    ),
    type: "message.delivered",
    source,
    chat: { id: input.chatId, kind: input.direct ? "direct" : "group" },
    assistantId: input.assistantId,
    sourceMessageId: input.sourceMessageId,
    dedupeKey: messageDedupeKey({
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      // A shared chat is one stream every bot in it mirrors idempotently; a
      // direct one belongs to the assistant that owns it.
      assistantId: input.direct ? input.assistantId : null,
    }),
    content: input.content,
    replyToSourceMessageId: input.replyToSourceMessageId,
    sentAt: new Date().toISOString(),
    threadId: input.threadId ?? null,
    silent: input.silent ?? false,
    image: input.image ?? null,
    running: ctx.running(),
  };
  await ctx.publisher.publish(event);
}

export async function sendChatMessage(
  ctx: SendContext,
  input: SendInput,
): Promise<SentChatMessage> {
  const reportFailure =
    ctx.onReportFailure ??
    ((sourceMessageId: string, err: unknown) =>
      console.error(
        `Failed to report delivery ${input.chatId}:${sourceMessageId}:`,
        err instanceof Error ? err.message : String(err),
      ));

  // Empty text is sent as-is: the platform's refusal is the honest answer,
  // and it reaches the caller as the send error it is.
  const parts = splitMessage(input.text, ctx.descriptor.maxMessageLength);
  if (parts.length === 0) parts.push(input.text);

  const connection = ctx.connectionFor(input.assistantId);
  let first: SentChatMessage | null = null;
  const sourceMessageIds: string[] = [];

  for (const part of parts) {
    const sent = await connection.sendMessage(input.chatId, part, {
      replyToSourceMessageId: input.replyToSourceMessageId ?? null,
      threadId: input.threadId ?? null,
      silent: input.silent ?? false,
      linkableSourceMessageIds: input.linkableSourceMessageIds ?? [],
    });
    sourceMessageIds.push(sent.sourceMessageId);
    first ??= {
      sourceMessageId: sent.sourceMessageId,
      replyToSourceMessageId: sent.replyToSourceMessageId,
      sourceMessageIds,
    };

    await publishDelivered(ctx, {
      chatId: input.chatId,
      assistantId: input.assistantId,
      sourceMessageId: sent.sourceMessageId,
      content: part,
      direct: input.direct,
      // What is actually in the chat, not what was asked for.
      replyToSourceMessageId: sent.replyToSourceMessageId,
      threadId: input.threadId,
      silent: input.silent,
    }).catch((err) => reportFailure(sent.sourceMessageId, err));
  }
  return first!;
}

/** The `/health` body every transport serves, from its statuses. */
export function healthBody(statuses: ConnectionStatus[]) {
  return { ok: true, connections: statuses };
}
