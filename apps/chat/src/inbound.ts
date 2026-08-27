import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  turnCorrelationId,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";

import { normalizeImageForChat } from "@assistant-hub/media";

import { buildChatInfo, buildConversationContext, buildSenderInfo, threadOwner } from "./context";
import type { ChatDb } from "./db";
import { insertMedia } from "./media";
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
 *
 * An uploaded image is normalized here and stored `pending`, then referenced
 * on the event exactly as a Telegram photo is: the core describes it over the
 * media API and writes the text back. A voice note is stored raw and
 * referenced the same way; the core transcribes it and answers the words.
 * Media that cannot be stored does NOT lose the message — the turn runs on
 * the text, the way a media message the tg ingest could not store still gets
 * answered.
 */

export interface PostMessageResult {
  message: ChatMessageRow;
  /** The turn's correlation id, or null when nothing was enqueued. */
  correlationId: string | null;
  /** The stored media row, when the message carried an image. */
  media: { id: string; kind: string; status: string; description: string | null } | null;
}

export async function postThreadMessage(input: {
  db: ChatDb;
  threadId: string;
  text: string;
  /** An uploaded image, as the browser read it. */
  image?: { dataBase64: string; mimeType?: string | null } | null;
  /** A recorded voice note, in the browser's own container. */
  audio?: { dataBase64: string; mimeType?: string | null } | null;
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

  // One attachment per message (the store's index): a picture or a voice
  // note. A voice note's bytes are stored raw — the core converts before
  // transcribing, exactly as it does for Telegram audio.
  const stored = input.image
    ? await insertImage(input.db, message.id, input.image).catch(() => null)
    : input.audio
      ? await insertMedia(input.db, {
          messageId: message.id,
          kind: "voice",
          mimeType: input.audio.mimeType ?? "audio/webm",
          frames: [input.audio.dataBase64],
        }).catch(() => null)
      : null;

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
      media: stored
        ? [
            {
              id: stored.id,
              kind: stored.kind,
              description: stored.description,
              status: stored.status as "pending" | "described" | "unavailable",
            },
          ]
        : [],
    },
    context,
  } satisfies InboundMessageEvent);

  await input.enqueue(event);
  return {
    message,
    correlationId,
    media: stored
      ? {
          id: stored.id,
          kind: stored.kind,
          status: stored.status,
          description: stored.description,
        }
      : null,
  };
}

/** Normalize an upload to a bounded JPEG and store it as pending media. */
async function insertImage(
  db: ChatDb,
  messageId: number,
  image: { dataBase64: string; mimeType?: string | null },
) {
  const normalized = await normalizeImageForChat(image.dataBase64);
  return insertMedia(db, {
    messageId,
    kind: "image",
    mimeType: normalized.mimeHint,
    frames: [normalized.base64],
  });
}
