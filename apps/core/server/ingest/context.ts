import "server-only";

import {
  scopedRef,
  type ChatInfo,
  type ConversationContext,
  type HistoryMessage,
  type Participant,
  type SenderInfo,
  type SourceId,
  type TransportChat,
  type TransportUser,
} from "@assistant-hub-swarm/contracts";

import { formatKnownUserLabel } from "@/features/known-users/format";
import { renderMediaSuffix } from "@/features/vision/format";
import type { MediaAnnotation } from "@/features/vision/types";
import type { StoreDb } from "@/server/store/db";
import {
  getSourceChatById,
  getSourceMediaForMessages,
  getSourceMessagesSince,
  getSourceUserById,
  getSourceUsersByIds,
  listSourceChatMemberUsers,
  type ConversationScope,
} from "@/server/source-store/repository";

/**
 * Conversation-context composition for transport turns (redesign Phase 7):
 * the "context provider" duty moved from the source apps into the core with
 * the store — the ingest consumer composes the history window, participant
 * roster and chat/sender metadata from the conversation store when it builds
 * a turn event.
 *
 * Window semantics are the v1 reply window, byte-for-byte where it shows in
 * prompts: last 24 hours, insertion order, soft-deleted excluded, the
 * current turn excluded, labels from the stored profiles, media annotations
 * rendered as ` [photo: …]` suffixes.
 */

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fallback speaker label when a sender cannot be resolved to a stored user. */
function fallbackUserLabel(userId: string | null): string {
  return userId ? `User ${userId}` : "User";
}

/** The composed history window for one inbound message. */
export async function buildHistoryWindow(
  scope: ConversationScope,
  input: { excludeSourceMessageId: string; now?: Date },
  db?: StoreDb,
): Promise<HistoryMessage[]> {
  const since = new Date((input.now ?? new Date()).getTime() - HISTORY_WINDOW_MS);
  const rows = await getSourceMessagesSince(
    scope,
    since,
    { excludeSourceMessageId: input.excludeSourceMessageId },
    db,
  );
  const senders = await getSourceUsersByIds(
    scope.source,
    [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))],
    db,
  );
  const labels = new Map(senders.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const mediaByMessage = await getSourceMediaForMessages(
    scope.source,
    scope.chatId,
    rows.map((row) => row.sourceMessageId),
    db,
  );
  return rows.map((row) => {
    const mediaRow = mediaByMessage.get(row.sourceMessageId);
    return {
      sourceMessageId: row.sourceMessageId,
      role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
      // Whose words these are. In a group several assistants can speak, and
      // the pipeline renders another assistant's lines as somebody else, not
      // as the reader's own (the cross-feed makes that routine).
      assistantId: row.role === "assistant" ? row.assistantId : null,
      senderRef: row.userId ? scopedRef(scope.source, "user", row.userId) : null,
      senderLabel:
        row.role === "assistant"
          ? null
          : ((row.userId ? labels.get(row.userId) : undefined) ?? fallbackUserLabel(row.userId)),
      content: row.content,
      sentAt: row.sentAt.toISOString(),
      replyToSourceMessageId: row.replyToSourceMessageId,
      botReaction: row.botReaction,
      mediaNote: mediaRow ? renderMediaSuffix(mediaRow as MediaAnnotation) : null,
    };
  });
}

/** The participant roster: group → known members; direct → the sender alone. */
export async function buildParticipants(
  source: SourceId,
  input: { chatId: string; isGroup: boolean; senderId: string | null },
  db?: StoreDb,
): Promise<Participant[]> {
  if (input.isGroup) {
    const members = await listSourceChatMemberUsers(source, input.chatId, db);
    return members.map((user) => ({
      ref: scopedRef(source, "user", user.userId),
      label: formatKnownUserLabel(user),
      username: user.username,
      aliases: user.aliases,
    }));
  }
  if (!input.senderId) return [];
  const user = await getSourceUserById(source, input.senderId, db);
  if (!user) return [];
  return [
    {
      ref: scopedRef(source, "user", user.userId),
      label: formatKnownUserLabel(user),
      username: user.username,
      aliases: user.aliases,
    },
  ];
}

/** Chat metadata for the turn event: stored chat row, or the DM peer's language. */
export async function buildChatInfo(
  source: SourceId,
  chat: TransportChat,
  db?: StoreDb,
): Promise<ChatInfo> {
  const ref = scopedRef(source, "chat", chat.id);
  if (chat.kind === "direct") {
    // A telegram private chat's id equals the peer's user id; its reply
    // language is the user's setting (v1 semantics). A source whose direct
    // chats have their own ids simply resolves no user here.
    const user = await getSourceUserById(source, chat.id, db);
    return {
      ref,
      kind: "direct",
      title: chat.title ?? null,
      type: null,
      notes: null,
      language: user?.language ?? null,
    };
  }
  const stored = await getSourceChatById(source, chat.id, db);
  return {
    ref,
    kind: "group",
    title: stored?.title ?? chat.title ?? null,
    type: stored?.type ?? chat.type ?? null,
    notes: stored?.notes ?? null,
    language: stored?.language ?? null,
  };
}

/**
 * The sender, from the event's raw profile plus the stored curated fields.
 * `isOwner` is the CORE's judgement since Phase 8: resolved per receiving
 * assistant from accounts + identity links (`server/owner-rights.ts`) and
 * passed in by the ingest fan-out.
 */
export async function buildSenderInfo(
  source: SourceId,
  user: TransportUser,
  isOwner: boolean,
  db?: StoreDb,
): Promise<SenderInfo> {
  const stored = await getSourceUserById(source, user.userId, db);
  return {
    ref: scopedRef(source, "user", user.userId),
    isOwner,
    label: formatKnownUserLabel(user),
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    aliases: stored?.aliases ?? [],
    language: stored?.language ?? null,
  };
}

/** The full conversation context for one turn. */
export async function buildConversationContext(
  scope: ConversationScope,
  input: { senderId: string | null; excludeSourceMessageId: string; now?: Date },
  db?: StoreDb,
): Promise<ConversationContext> {
  const [history, participants] = await Promise.all([
    buildHistoryWindow(
      scope,
      { excludeSourceMessageId: input.excludeSourceMessageId, now: input.now },
      db,
    ),
    buildParticipants(
      scope.source,
      { chatId: scope.chatId, isGroup: !scope.direct, senderId: input.senderId },
      db,
    ),
  ]);
  return { history, participants };
}
