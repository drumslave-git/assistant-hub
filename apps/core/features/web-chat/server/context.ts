import "server-only";

import {
  scopedRef,
  type ChatInfo,
  type ConversationContext,
  type HistoryMessage,
  type Participant,
  type SenderInfo,
} from "@assistant-hub/contracts";

import type { StoreDb } from "@/server/store/db";

import type { AccountRow, WebThreadRow } from "../../../store/schema";
import { getChatUserById, getMessagesSince } from "./repository";

/**
 * The conversation context for a web-thread turn — history window +
 * participant roster + chat/sender metadata, composed from the web-chat
 * tables and carried on the inbound event, exactly as the chat app did
 * before the dissolve. The pipeline composes prompts from this.
 *
 * A thread is simpler than a Telegram chat by construction: one human, one
 * assistant, one stream. The window semantics still match tg's so the same
 * pipeline reads both the same way — last 24 hours, insertion order,
 * deleted rows and the current turn excluded.
 */

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function buildHistoryWindow(
  input: {
    thread: WebThreadRow;
    user: AccountRow;
    excludeMessageId: number;
    now?: Date;
  },
  db?: StoreDb,
): Promise<HistoryMessage[]> {
  const since = new Date((input.now ?? new Date()).getTime() - HISTORY_WINDOW_MS);
  // Passing `undefined` lets the repository's default handle pick up.
  const rows = await getMessagesSince(
    input.thread.id,
    since,
    { excludeMessageId: input.excludeMessageId },
    db,
  );
  return rows.map((row) => ({
    sourceMessageId: String(row.id),
    role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
    // Every assistant line in a thread is the thread's own assistant: the
    // binding is fixed at creation, so no other one can have spoken here.
    assistantId: row.role === "assistant" ? input.thread.assistantId : null,
    senderRef: row.role === "assistant" ? null : scopedRef("chat", "user", input.user.id),
    senderLabel: row.role === "assistant" ? null : chatUserLabel(input.user),
    content: row.content,
    sentAt: row.sentAt.toISOString(),
    replyToSourceMessageId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
    botReaction: null,
    mediaNote: null,
  }));
}

/** How an account reads as a chat participant. */
export function chatUserLabel(user: AccountRow): string {
  return user.displayName ?? user.username;
}

/** The roster of a thread: its owner, and nobody else. */
export function buildParticipants(user: AccountRow): Participant[] {
  return [
    {
      ref: scopedRef("chat", "user", user.id),
      label: chatUserLabel(user),
      username: user.username,
      aliases: user.aliases,
    },
  ];
}

/**
 * The thread as a conversation. Always `direct`: one human talking to one
 * assistant, which is also why every message in it is addressed.
 */
export function buildChatInfo(thread: WebThreadRow): ChatInfo {
  return {
    ref: scopedRef("chat", "thread", thread.id),
    kind: "direct",
    title: thread.name,
    type: null,
    notes: thread.notes,
    language: thread.language,
    // Ask the pipeline to name this thread once there is something to name it
    // from; it does that through `setChatTitle` on the outbound port.
    titleProvisional: thread.titleProvisional,
  };
}

/**
 * The sender. `isOwner` is the same judgement every source gets (Phase 8):
 * resolved by the caller from accounts + assistant ownership
 * (`server/owner-rights.ts`) — here the sender IS an account, so the
 * resolver short-circuits on the direct ref.
 */
export function buildSenderInfo(user: AccountRow, isOwner: boolean): SenderInfo {
  return {
    ref: scopedRef("chat", "user", user.id),
    isOwner,
    label: chatUserLabel(user),
    username: user.username,
    firstName: null,
    lastName: null,
    aliases: user.aliases,
    language: user.language,
  };
}

export async function buildConversationContext(
  input: { thread: WebThreadRow; user: AccountRow; excludeMessageId: number; now?: Date },
  db?: StoreDb,
): Promise<ConversationContext> {
  return {
    history: await buildHistoryWindow(input, db),
    participants: buildParticipants(input.user),
  };
}

/** The thread's owning account, or null when the thread points at nobody. */
export async function threadOwner(
  thread: WebThreadRow,
  db?: StoreDb,
): Promise<AccountRow | null> {
  return getChatUserById(thread.userId, db);
}
