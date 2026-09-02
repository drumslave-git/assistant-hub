import "server-only";

import type { OperatorChat, OperatorChatMember, OperatorUser } from "@assistant-hub-swarm/contracts";

import { ApiError } from "@/lib/api-error";
import type { SourceDirectoryClient } from "@/server/source/operator-client";

import type { AccountRow } from "../../../store/schema";
import {
  getThreadListing,
  listChatUsers,
  listThreadListings,
  listThreadMembers,
  updateChatUserAliases,
  updateChatUserLanguage,
  updateThreadLanguage,
  updateThreadNotes,
  type ThreadListing,
} from "./repository";
import { pingThreads } from "./service";

/**
 * The web chat's side of the operator listing/CRUD contract, as direct store
 * reads since the dissolve — the dashboard's aggregated users/groups pages
 * fan out over every source through {@link SourceDirectoryClient}, and this
 * is the `chat` entry answering from the core's own tables instead of over
 * HTTP.
 *
 * A thread is this source's conversation shape: one human, one assistant
 * bound at creation. The contract's `kind` is therefore always `direct`, and
 * a thread's roster is its owner.
 */

function toOperatorUser(row: AccountRow): OperatorUser {
  return {
    id: row.id,
    // The account IS the web identity (Phase 8): its username doubles as
    // the handle, its display name as the label. Never the secrets.
    username: row.username,
    firstName: null,
    lastName: null,
    label: row.displayName ?? row.username,
    aliases: row.aliases,
    language: row.language,
    firstSeenAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOperatorChat(listing: ThreadListing): OperatorChat {
  return {
    id: listing.thread.id,
    kind: "direct",
    title: listing.thread.name,
    type: null,
    notes: listing.thread.notes,
    language: listing.thread.language,
    messageCount: listing.messageCount,
    // One human per thread — the roster this source injects has one row.
    memberCount: 1,
    lastMessageAt: listing.lastMessageAt ? listing.lastMessageAt.toISOString() : null,
  };
}

export function webChatDirectoryClient(): SourceDirectoryClient {
  return {
    async listUsers() {
      const rows = await listChatUsers();
      return rows.map(toOperatorUser);
    },
    async listChats() {
      const listings = await listThreadListings();
      return listings.map(toOperatorChat);
    },
    async getChat(chatId) {
      const listing = await getThreadListing(chatId);
      return listing ? toOperatorChat(listing) : null;
    },
    async listChatMembers(chatId): Promise<OperatorChatMember[]> {
      const members = await listThreadMembers(chatId);
      return members.map((member) => ({
        ...toOperatorUser(member.user),
        memberSinceAt: member.memberSinceAt.toISOString(),
        lastSeenAt: member.lastSeenAt.toISOString(),
      }));
    },
    async updateUser(id, input) {
      const row =
        "aliases" in input
          ? await updateChatUserAliases(id, input.aliases)
          : await updateChatUserLanguage(id, input.language);
      if (!row) throw ApiError.notFound("user not found");
      return toOperatorUser(row);
    },
    async updateChat(id, input) {
      const row =
        "notes" in input
          ? await updateThreadNotes(id, input.notes)
          : await updateThreadLanguage(id, input.language);
      if (!row) throw ApiError.notFound("thread not found");
      pingThreads();
      const listing = await getThreadListing(id);
      if (!listing) throw ApiError.notFound("thread not found");
      return toOperatorChat(listing);
    },
  };
}
