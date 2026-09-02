import "server-only";

import type {
  OperatorChat,
  OperatorChatMember,
  OperatorUser,
  SourceId,
} from "@assistant-hub-swarm/contracts";

import { formatKnownUserLabel } from "@/features/known-users/format";
import { ApiError } from "@/lib/api-error";
import type { SourceDirectoryClient } from "@/server/source/operator-client";

import {
  listSourceChatListings,
  listSourceChatMemberListings,
  listSourceUsers,
  updateSourceChatLanguage,
  updateSourceChatNotes,
  updateSourceUserAliases,
  updateSourceUserLanguage,
  type SourceChatListing,
  type SourceUserRow,
} from "./repository";

/**
 * The operator listing/CRUD contract served from the conversation store
 * (redesign Phase 7) — the dashboard's aggregated users/groups pages fan out
 * over every source through {@link SourceDirectoryClient}, and a transport's
 * entry answers from the core's own tables instead of over HTTP.
 *
 * Telegram-shaped only in one place: a chat with no stored row is a direct
 * conversation (transports create chat rows for groups), and the kind of a
 * stored row follows its `type`.
 */

function toOperatorUser(row: SourceUserRow): OperatorUser {
  return {
    id: row.userId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    label: formatKnownUserLabel(row),
    aliases: row.aliases,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOperatorChat(listing: SourceChatListing): OperatorChat {
  return {
    id: listing.chatId,
    // A chat row exists for groups (transports create them on activity); a
    // conversation without one is a direct chat.
    kind: listing.chat ? "group" : "direct",
    title: listing.chat?.title ?? null,
    type: listing.chat?.type ?? null,
    notes: listing.chat?.notes ?? null,
    language: listing.chat?.language ?? null,
    messageCount: listing.messageCount,
    memberCount: listing.memberCount,
    lastMessageAt: listing.lastMessageAt ? listing.lastMessageAt.toISOString() : null,
  };
}

/** The listing/CRUD client for one transport source, over the store. */
export function sourceDirectoryClient(source: SourceId): SourceDirectoryClient {
  return {
    async listUsers() {
      return (await listSourceUsers(source)).map(toOperatorUser);
    },
    async listChats() {
      return (await listSourceChatListings(source)).map(toOperatorChat);
    },
    async getChat(chatId) {
      const listing = (await listSourceChatListings(source)).find(
        (entry) => entry.chatId === chatId,
      );
      return listing ? toOperatorChat(listing) : null;
    },
    async listChatMembers(chatId): Promise<OperatorChatMember[]> {
      const members = await listSourceChatMemberListings(source, chatId);
      return members.map((member) => ({
        ...toOperatorUser(member.user),
        memberSinceAt: member.memberSinceAt.toISOString(),
        lastSeenAt: member.lastSeenAt.toISOString(),
      }));
    },
    async updateUser(id, input) {
      const row =
        "aliases" in input
          ? await updateSourceUserAliases(source, id, input.aliases)
          : await updateSourceUserLanguage(source, id, input.language);
      if (!row) throw ApiError.notFound("user not found");
      return toOperatorUser(row);
    },
    async updateChat(id, input) {
      const row =
        "notes" in input
          ? await updateSourceChatNotes(source, id, input.notes)
          : await updateSourceChatLanguage(source, id, input.language);
      if (!row) throw ApiError.notFound("chat not found");
      const listing = (await listSourceChatListings(source)).find((entry) => entry.chatId === id);
      if (!listing) throw ApiError.notFound("chat not found");
      return toOperatorChat(listing);
    },
  };
}
