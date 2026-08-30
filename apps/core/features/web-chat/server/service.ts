import "server-only";

import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  turnCorrelationId,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import { normalizeImageForChat } from "@assistant-hub/media";

import { ApiError } from "@/lib/api-error";
import { publishEvent } from "@/server/realtime/hub";
import type { StoreDb } from "@/server/store/db";
import { enqueueInboundEvent } from "@/server/turn/enqueue";

import type { WebMessageRow } from "../../../store/schema";
import type { ChatThread, ChatThreadMessage, ChatThreadTurn } from "../schema";
import { buildChatInfo, buildConversationContext, buildSenderInfo, threadOwner } from "./context";
import { getMediaForMessages, insertMedia } from "./media-repository";
import {
  appendMessage,
  createThread,
  deleteThread,
  getOrCreateOperatorUser,
  getThreadById,
  getThreadListing,
  listLiveMessages,
  listThreadListings,
  renameThread,
  type ThreadListing,
} from "./repository";
import { threadTurns } from "./turns";

/**
 * The web-chat feature service — the thread API the dashboard drives, running
 * in-process since the chat dissolve (redesign Phase 6). What used to be the
 * chat app's Hono endpoints behind the proxy is now ordinary core server
 * code: store the message, compose the context, enqueue the turn. The turn
 * itself still travels the one pipeline entrance (the inbound queue), so a
 * web turn keeps tg's ordering, retry and settle semantics.
 */

/** Every thread change is something a dashboard page is showing — ping it. */
export function pingThreads(): void {
  publishEvent("threads");
}

function toChatThread(listing: ThreadListing): ChatThread {
  return {
    id: listing.thread.id,
    assistantId: listing.thread.assistantId,
    name: listing.thread.name,
    titleProvisional: listing.thread.titleProvisional,
    userId: listing.thread.userId,
    messageCount: listing.messageCount,
    lastMessageAt: listing.lastMessageAt ? listing.lastMessageAt.toISOString() : null,
    createdAt: listing.thread.createdAt.toISOString(),
    updatedAt: listing.thread.updatedAt.toISOString(),
  };
}

function toThreadMessage(
  row: WebMessageRow,
  attached?: { id: string; kind: string; status: string; description: string | null } | null,
): ChatThreadMessage {
  return {
    id: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    sentAt: row.sentAt.toISOString(),
    replyToId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
    media: attached
      ? {
          id: attached.id,
          kind: attached.kind,
          status: attached.status as "pending" | "described" | "unavailable",
          description: attached.description,
        }
      : null,
  };
}

/** Every thread, most recent first. */
export async function listChatThreads(db?: StoreDb): Promise<ChatThread[]> {
  const listings = await listThreadListings(db);
  return listings.map(toChatThread);
}

/**
 * Start a thread with one assistant, owned by the operator's web user
 * (single-operator system until Phase 8's accounts).
 */
export async function createChatThread(
  input: {
    assistantId: string;
    name?: string;
  },
  db?: StoreDb,
): Promise<ChatThread> {
  const user = await getOrCreateOperatorUser(db);
  const thread = await createThread(
    {
      userId: user.id,
      assistantId: input.assistantId,
      name: input.name ?? null,
    },
    db,
  );
  pingThreads();
  return toChatThread({ thread, messageCount: 0, lastMessageAt: null });
}

/** One thread with its transcript and its running turn, if any. */
export async function getChatThread(
  id: string,
  db?: StoreDb,
): Promise<{ thread: ChatThread; messages: ChatThreadMessage[]; turn: ChatThreadTurn | null }> {
  const listing = await getThreadListing(id, db);
  if (!listing) throw ApiError.notFound("thread not found");
  const rows = await listLiveMessages(id, db);
  const attached = await getMediaForMessages(rows.map((row) => row.id), db);
  const turn = threadTurns().get(id);
  return {
    thread: toChatThread(listing),
    messages: rows.map((row) => toThreadMessage(row, attached.get(row.id) ?? null)),
    turn: turn
      ? {
          sourceMessageId: turn.sourceMessageId,
          activity: turn.activity,
          since: turn.since.toISOString(),
        }
      : null,
  };
}

/** Rename a thread. The assistant is fixed at creation — only the name moves. */
export async function renameChatThread(
  id: string,
  name: string,
  db?: StoreDb,
): Promise<ChatThread> {
  const row = await renameThread(id, name, db);
  if (!row) throw ApiError.notFound("thread not found");
  pingThreads();
  const listing = await getThreadListing(row.id, db);
  if (!listing) throw ApiError.notFound("thread not found");
  return toChatThread(listing);
}

/** Delete a thread and everything in it. */
export async function deleteChatThread(id: string, db?: StoreDb): Promise<void> {
  threadTurns().clear(id);
  const deleted = await deleteThread(id, db);
  if (!deleted) throw ApiError.notFound("thread not found");
  pingThreads();
}

/** What one post stores and starts. */
export interface PostMessageResult {
  message: ChatThreadMessage;
  /** The turn's correlation id, or null when nothing was enqueued. */
  correlationId: string | null;
}

/**
 * The human speaks: store it, then start the turn — the inbound half of what
 * the chat app used to do behind the source contract.
 *
 * Everything transport-shaped that Telegram needs is absent here by
 * construction, and that absence is the point:
 *
 * - **Addressing is settled**: a message typed into a thread is addressed to
 *   that thread's assistant. There is nobody else in the room to mean, so the
 *   verdict is `private` and the analyzer never runs.
 * - **No connection identity**: a thread has no bot account. The event omits
 *   it and the pipeline uses the assistant's own name.
 * - **One assistant per message**: the thread's binding is fixed at creation,
 *   so unlike a group there is never a fan-out.
 *
 * An uploaded image is normalized and stored `pending`, then referenced on
 * the event exactly as a Telegram photo is: the vision pass describes it and
 * writes the text back. A voice note is stored raw and referenced the same
 * way; the pipeline transcribes it and answers the words. Media that cannot
 * be stored does NOT lose the message — the turn runs on the text.
 */
export async function postChatMessage(
  threadId: string,
  input: {
    text: string;
    image?: { dataBase64: string; mimeType?: string | null } | null;
    audio?: { dataBase64: string; mimeType?: string | null } | null;
  },
  options: { now?: () => Date; db?: StoreDb } = {},
): Promise<PostMessageResult> {
  const now = options.now?.() ?? new Date();
  const db = options.db;
  const thread = await getThreadById(threadId, db);
  if (!thread) throw ApiError.notFound("thread not found");
  const user = await threadOwner(thread, db);
  if (!user) throw ApiError.notFound("thread not found");

  // Store first: the transcript is the durable record, and a turn that fails
  // to enqueue must still leave what the person said behind.
  const message = await appendMessage(
    {
      threadId: thread.id,
      role: "user",
      content: input.text,
      sentAt: now,
    },
    db,
  );

  // One attachment per message (the store's index): a picture or a voice
  // note. A voice note's bytes are stored raw — the pipeline converts before
  // transcribing, exactly as it does for Telegram audio.
  const stored = input.image
    ? await insertNormalizedImage(message.id, input.image, db).catch(() => null)
    : input.audio
      ? await insertMedia(
          {
            messageId: message.id,
            kind: "voice",
            mimeType: input.audio.mimeType ?? "audio/webm",
            frames: [input.audio.dataBase64],
          },
          db,
        ).catch(() => null)
      : null;

  const context = await buildConversationContext(
    { thread, user, excludeMessageId: message.id, now },
    db,
  );

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

  await enqueueInboundEvent(event);
  pingThreads();
  return {
    message: toThreadMessage(
      message,
      stored
        ? {
            id: stored.id,
            kind: stored.kind,
            status: stored.status,
            description: stored.description,
          }
        : null,
    ),
    correlationId,
  };
}

/** Normalize an upload to a bounded JPEG and store it as pending media. */
async function insertNormalizedImage(
  messageId: number,
  image: { dataBase64: string; mimeType?: string | null },
  db?: StoreDb,
) {
  const normalized = await normalizeImageForChat(image.dataBase64);
  return insertMedia(
    {
      messageId,
      kind: "image",
      mimeType: normalized.mimeHint,
      frames: [normalized.base64],
    },
    db,
  );
}
