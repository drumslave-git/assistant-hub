import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  turnCorrelationId,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";

import { buildChatInfo, buildConversationContext, buildSenderInfo, threadOwner } from "./context";
import type { ChatDb } from "./db";
import { appendMessage, getThreadById } from "./store";
import type { ChatMessageRow } from "../store/schema";

/**
 * The inbound half of the source contract for web threads: persist what the
 * human said in this app's store, compose the conversation context, and hand
 * ONE normalized event to `enqueue` — the core's pipeline consumes it from
 * the queue and never reads this database.
 *
 * Everything transport-shaped that Telegram needs is absent here by
 * construction, and that absence is the point:
 *
 * - **Addressing is settled**: a message typed into a thread is addressed to
 *   that thread's assistant. There is nobody else in the room to mean, so the
 *   verdict is `private` and the core's analyzer never runs.
 * - **No connection identity**: a thread has no bot account. The event omits
 *   it and the core uses the assistant's own name (contract note on
 *   `connection`).
 * - **One assistant per message**: the thread's binding is fixed at creation,
 *   so unlike a group there is never a fan-out.
 */

export interface PostMessageResult {
  message: ChatMessageRow;
  /** The turn's correlation id, or null when nothing was enqueued. */
  correlationId: string | null;
}

export async function postThreadMessage(input: {
  db: ChatDb;
  threadId: string;
  text: string;
  /** Publish the event as one queue job. A failure surfaces to the caller. */
  enqueue: (event: InboundMessageEvent) => Promise<void>;
  now?: () => Date;
}): Promise<PostMessageResult | null> {
  const now = input.now?.() ?? new Date();
  const thread = await getThreadById(input.db, input.threadId);
  if (!thread) return null;
  const user = await threadOwner(input.db, thread);
  if (!user) return null;

  // Store first: the transcript is this app's own record, and a turn that
  // fails to enqueue must still leave what the person said behind.
  const message = await appendMessage(input.db, {
    threadId: thread.id,
    role: "user",
    content: input.text,
    sentAt: now,
  });

  const context = await buildConversationContext(input.db, {
    thread,
    user,
    excludeMessageId: message.id,
    now,
  });

  const correlationId = turnCorrelationId(thread.id, String(message.id), thread.assistantId);
  const event = inboundMessageEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    correlationId,
    type: "message.inbound",
    source: "chat",
    assistantId: thread.assistantId,
    chat: buildChatInfo(thread),
    sender: buildSenderInfo(user),
    addressing: {
      addressed: true,
      source: "private",
      needsAnalyzer: false,
      reason: "a message in a thread is addressed to that thread's assistant",
    },
    message: {
      sourceMessageId: String(message.id),
      content: input.text,
      sentAt: message.sentAt.toISOString(),
      threadId: null,
      replyTo: null,
      media: [],
    },
    context,
  } satisfies InboundMessageEvent);

  await input.enqueue(event);
  return { message, correlationId };
}
