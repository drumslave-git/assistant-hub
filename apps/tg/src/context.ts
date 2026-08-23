import {
  scopedRef,
  type ChatInfo,
  type ConversationContext,
  type HistoryMessage,
  type Participant,
  type SenderInfo,
} from "@assistant-hub/contracts";

import type { TgDb } from "./db";
import { fallbackUserLabel, formatUserLabel, renderMediaNote } from "./format";
import {
  getChatById,
  getMediaForMessages,
  getMessagesSince,
  getTgSettings,
  getUserById,
  getUsersByIds,
  listChatMemberUsers,
  setResolvedOwnerUserId,
} from "./store";

/**
 * The source contract's "context provider" duty (PLAN.md): compose the
 * conversation context — history window + participant roster + chat/sender
 * metadata — from this app's own store, carried on the inbound event. The
 * core composes prompts from this; it never queries this database.
 *
 * Window semantics are the v1 reply window, byte-for-byte where it shows in
 * prompts: last 24 hours, insertion order, soft-deleted excluded, the
 * current turn excluded, labels from the stored profiles, media annotations
 * rendered as ` [photo: …]` suffixes.
 */

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The composed history window for one inbound message. */
export async function buildHistoryWindow(
  db: TgDb,
  input: { chatId: string; excludeTelegramMessageId: number; now?: Date },
): Promise<HistoryMessage[]> {
  const since = new Date((input.now ?? new Date()).getTime() - HISTORY_WINDOW_MS);
  const rows = await getMessagesSince(db, input.chatId, since, {
    excludeTelegramMessageId: input.excludeTelegramMessageId,
  });
  const senders = await getUsersByIds(
    db,
    [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))],
  );
  const labels = new Map(senders.map((u) => [u.userId, formatUserLabel(u)]));
  const mediaByMessage = await getMediaForMessages(
    db,
    input.chatId,
    rows.map((row) => row.telegramMessageId),
  );
  return rows.map((row) => {
    const mediaRow = mediaByMessage.get(row.telegramMessageId);
    return {
      sourceMessageId: String(row.telegramMessageId),
      role: row.role === "assistant" ? "assistant" : "user",
      senderRef: row.userId ? scopedRef("tg", "user", row.userId) : null,
      senderLabel:
        row.role === "assistant"
          ? null
          : (row.userId ? labels.get(row.userId) : undefined) ?? fallbackUserLabel(row.userId),
      content: row.content,
      sentAt: row.sentAt.toISOString(),
      replyToSourceMessageId:
        row.replyToMessageId != null ? String(row.replyToMessageId) : null,
      botReaction: row.botReaction,
      mediaNote: mediaRow ? renderMediaNote(mediaRow) : null,
    };
  });
}

/** The participant roster: group → known members; direct → the sender alone. */
export async function buildParticipants(
  db: TgDb,
  input: { chatId: string; isGroup: boolean; senderId: string | null },
): Promise<Participant[]> {
  if (input.isGroup) {
    const members = await listChatMemberUsers(db, input.chatId);
    return members.map((user) => ({
      ref: scopedRef("tg", "user", user.userId),
      label: formatUserLabel(user),
      username: user.username,
      aliases: user.aliases,
    }));
  }
  if (!input.senderId) return [];
  const user = await getUserById(db, input.senderId);
  if (!user) return [];
  return [
    {
      ref: scopedRef("tg", "user", user.userId),
      label: formatUserLabel(user),
      username: user.username,
      aliases: user.aliases,
    },
  ];
}

/** Chat metadata for the event: stored group row, or the DM peer's language. */
export async function buildChatInfo(
  db: TgDb,
  input: { chatId: string; isGroup: boolean; title: string | null },
): Promise<ChatInfo> {
  const ref = scopedRef("tg", "chat", input.chatId);
  if (!input.isGroup) {
    // A private chat's id equals the peer's user id; its reply language is
    // the user's setting (v1 semantics).
    const user = await getUserById(db, input.chatId);
    return {
      ref,
      kind: "direct",
      title: input.title,
      type: null,
      notes: null,
      language: user?.language ?? null,
    };
  }
  const chat = await getChatById(db, input.chatId);
  return {
    ref,
    kind: "group",
    title: chat?.title ?? input.title,
    type: chat?.type ?? null,
    notes: chat?.notes ?? null,
    language: chat?.language ?? null,
  };
}

/**
 * The sender, with the owner check RESOLVED here (user decision, 2026-08-22:
 * owner logic lives on the app side; the core only sees the flag). Matching
 * the configured @username resolves and persists the owner's numeric id, v1
 * semantics.
 */
export async function buildSenderInfo(
  db: TgDb,
  input: {
    userId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  },
): Promise<SenderInfo> {
  const stored = await getUserById(db, input.userId);
  const settings = await getTgSettings(db);
  let isOwner = settings.ownerUserId != null && settings.ownerUserId === input.userId;
  if (!isOwner && settings.ownerUserId == null && settings.ownerUsername) {
    const username = input.username?.toLowerCase() ?? null;
    if (username && username === settings.ownerUsername.toLowerCase()) {
      isOwner = true;
      await setResolvedOwnerUserId(db, input.userId).catch(() => undefined);
    }
  }
  return {
    ref: scopedRef("tg", "user", input.userId),
    isOwner,
    label: formatUserLabel({
      userId: input.userId,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
    }),
    username: input.username,
    firstName: input.firstName,
    lastName: input.lastName,
    aliases: stored?.aliases ?? [],
    language: stored?.language ?? null,
  };
}

/** The full conversation context for one inbound message. */
export async function buildConversationContext(
  db: TgDb,
  input: {
    chatId: string;
    isGroup: boolean;
    senderId: string | null;
    excludeTelegramMessageId: number;
    now?: Date;
  },
): Promise<ConversationContext> {
  const [history, participants] = await Promise.all([
    buildHistoryWindow(db, {
      chatId: input.chatId,
      excludeTelegramMessageId: input.excludeTelegramMessageId,
      now: input.now,
    }),
    buildParticipants(db, input),
  ]);
  return { history, participants };
}
