import "server-only";

import type { OperatorChat, OperatorChatMember, OperatorUser } from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";
import type { SourceDirectoryClient } from "@/server/source/operator-client";

import type { WebUserRow } from "../../../store/schema";
import {
  getThreadListing,
  listThreadListings,
  listThreadMembers,
  listUsers,
  updateThreadLanguage,
  updateThreadNotes,
  updateUserAliases,
  updateUserLanguage,
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

function toOperatorUser(row: WebUserRow): OperatorUser {
  return {
    id: row.id,
    // A web user has one name and no @handle — the shape's other name parts
    // belong to the sources that have them.
    username: null,
    firstName: null,
    lastName: null,
    label: row.name,
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
      const rows = await listUsers();
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
          ? await updateUserAliases(id, input.aliases)
          : await updateUserLanguage(id, input.language);
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
