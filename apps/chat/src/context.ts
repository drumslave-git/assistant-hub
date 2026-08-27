import {
  scopedRef,
  type ChatInfo,
  type ConversationContext,
  type HistoryMessage,
  type Participant,
  type SenderInfo,
} from "@assistant-hub/contracts";

import type { ChatDb } from "./db";
import { getMessagesSince, getUserById } from "./store";
import type { ChatUserRow, ThreadRow } from "../store/schema";

/**
 * The source contract's "context provider" duty (PLAN.md): compose the
 * conversation context — history window + participant roster + chat/sender
 * metadata — from this app's own store, carried on the inbound event. The
 * core composes prompts from this; it never queries this database.
 *
 * A thread is simpler than a Telegram chat by construction: one human, one
 * assistant, one stream. The window semantics still match tg's so the same
 * pipeline reads both the same way — last 24 hours, insertion order,
 * deleted rows and the current turn excluded.
 */

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function buildHistoryWindow(
  db: ChatDb,
  input: {
    thread: ThreadRow;
    user: ChatUserRow;
    excludeMessageId: number;
    now?: Date;
  },
): Promise<HistoryMessage[]> {
  const since = new Date((input.now ?? new Date()).getTime() - HISTORY_WINDOW_MS);
  const rows = await getMessagesSince(db, input.thread.id, since, {
    excludeMessageId: input.excludeMessageId,
  });
  return rows.map((row) => ({
    sourceMessageId: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    // Every assistant line in a thread is the thread's own assistant: the
    // binding is fixed at creation, so no other one can have spoken here.
    assistantId: row.role === "assistant" ? input.thread.assistantId : null,
    senderRef: row.role === "assistant" ? null : scopedRef("chat", "user", input.user.id),
    senderLabel: row.role === "assistant" ? null : input.user.name,
    content: row.content,
    sentAt: row.sentAt.toISOString(),
    replyToSourceMessageId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
    botReaction: null,
    mediaNote: null,
  }));
}

/** The roster of a thread: its owner, and nobody else. */
export function buildParticipants(user: ChatUserRow): Participant[] {
  return [
    {
      ref: scopedRef("chat", "user", user.id),
      label: user.name,
      username: null,
      aliases: user.aliases,
    },
  ];
}

/**
 * The thread as a conversation. Always `direct`: one human talking to one
 * assistant, which is also why every message in it is addressed.
 */
export function buildChatInfo(thread: ThreadRow): ChatInfo {
  return {
    ref: scopedRef("chat", "thread", thread.id),
    kind: "direct",
    title: thread.name,
    type: null,
    notes: thread.notes,
    language: thread.language,
    // Ask the core to name this thread once there is something to name it
    // from; it does that through `setChatTitle` on its outbound port.
    titleProvisional: thread.titleProvisional,
  };
}

/**
 * The sender. `isOwner` is resolved here, as the contract requires (owner
 * logic lives on the app side): this app's operator user IS the operator, so
 * the flag follows the row's own `is_operator`, with no username matching to
 * do.
 */
export function buildSenderInfo(user: ChatUserRow): SenderInfo {
  return {
    ref: scopedRef("chat", "user", user.id),
    isOwner: user.isOperator,
    label: user.name,
    username: null,
    firstName: null,
    lastName: null,
    aliases: user.aliases,
    language: user.language,
  };
}

export async function buildConversationContext(
  db: ChatDb,
  input: { thread: ThreadRow; user: ChatUserRow; excludeMessageId: number; now?: Date },
): Promise<ConversationContext> {
  return {
    history: await buildHistoryWindow(db, input),
    participants: buildParticipants(input.user),
  };
}

/** The thread's owner, or null when the thread points at nobody (never, in practice). */
export async function threadOwner(db: ChatDb, thread: ThreadRow): Promise<ChatUserRow | null> {
  return getUserById(db, thread.userId);
}
