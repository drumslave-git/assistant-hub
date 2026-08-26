import { describe, expect, it } from "vitest";

import type { OperatorChat, OperatorUser } from "@assistant-hub/contracts";

import {
  listDirectoryChats,
  listDirectoryUsers,
  type DirectorySource,
  type SourceDirectoryClient,
} from "./directory";

/**
 * The aggregation seam itself: fan-out across registered sources, scoped refs,
 * ordering, and the rule that one unreachable source narrows the listing
 * instead of failing (or silently emptying) it. Sources are injected, so the
 * multi-source behavior is covered before `apps/chat` exists.
 */

const user = (id: string, updatedAt: string): OperatorUser => ({
  id,
  username: `user_${id}`,
  firstName: "Fixture",
  lastName: null,
  label: `Fixture ${id}`,
  aliases: [],
  language: null,
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  updatedAt,
});

const chat = (id: string, lastMessageAt: string | null): OperatorChat => ({
  id,
  kind: id.startsWith("-") ? "group" : "direct",
  title: null,
  type: null,
  notes: null,
  language: null,
  messageCount: 3,
  memberCount: 2,
  lastMessageAt,
});

/** A source whose client answers with the given rows. */
function source(
  id: DirectorySource["id"],
  label: string,
  rows: { users?: OperatorUser[]; chats?: OperatorChat[] },
): DirectorySource {
  const client: SourceDirectoryClient = {
    listUsers: async () => rows.users ?? [],
    listChats: async () => rows.chats ?? [],
    getChat: async () => null,
    listChatMembers: async () => [],
    updateUser: async () => {
      throw new Error("not used");
    },
    updateChat: async () => {
      throw new Error("not used");
    },
  };
  return { id, label, client: () => client };
}

/** A source that is registered but has no client in this deployment. */
const unconfigured = (id: DirectorySource["id"], label: string): DirectorySource => ({
  id,
  label,
  client: () => null,
});

/** A source whose client is there but whose API refuses the read. */
const failing = (id: DirectorySource["id"], label: string, message: string): DirectorySource => ({
  id,
  label,
  client: () => ({
    listUsers: async () => {
      throw new Error(message);
    },
    listChats: async () => {
      throw new Error(message);
    },
    getChat: async () => null,
    listChatMembers: async () => [],
    updateUser: async () => {
      throw new Error(message);
    },
    updateChat: async () => {
      throw new Error(message);
    },
  }),
});

describe("listDirectoryUsers", () => {
  it("tags every row with its source and scoped ref, newest first", async () => {
    const listing = await listDirectoryUsers([
      source("tg", "Telegram", { users: [user("1", "2026-08-20T00:00:00.000Z")] }),
      source("chat", "Web chat", { users: [user("abc", "2026-08-25T00:00:00.000Z")] }),
    ]);

    expect(listing.unavailable).toEqual([]);
    expect(listing.entries.map((entry) => entry.ref)).toEqual(["chat:user:abc", "tg:user:1"]);
    expect(listing.entries[0]).toMatchObject({ source: "chat", sourceLabel: "Web chat" });
  });

  it("names the sources it could not read instead of dropping them silently", async () => {
    const listing = await listDirectoryUsers([
      source("tg", "Telegram", { users: [user("1", "2026-08-20T00:00:00.000Z")] }),
      failing("chat", "Web chat", "connection refused"),
    ]);

    expect(listing.entries).toHaveLength(1);
    expect(listing.unavailable).toEqual([
      {
        source: "chat",
        sourceLabel: "Web chat",
        reason: "Web chat service unreachable: connection refused",
      },
    ]);
  });

  it("reports an unconfigured source as unavailable, not as empty", async () => {
    const listing = await listDirectoryUsers([unconfigured("tg", "Telegram")]);

    expect(listing.entries).toEqual([]);
    expect(listing.unavailable).toHaveLength(1);
    expect(listing.unavailable[0].reason).toContain("not configured");
  });
});

describe("listDirectoryChats", () => {
  it("orders by last message and keeps chats that have never had one", async () => {
    const listing = await listDirectoryChats([
      source("tg", "Telegram", {
        chats: [chat("-100", null), chat("-200", "2026-08-26T00:00:00.000Z")],
      }),
      source("chat", "Web chat", { chats: [chat("t1", "2026-08-27T00:00:00.000Z")] }),
    ]);

    expect(listing.entries.map((entry) => entry.ref)).toEqual([
      "chat:chat:t1",
      "tg:chat:-200",
      "tg:chat:-100",
    ]);
  });
});
