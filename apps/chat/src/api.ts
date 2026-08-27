import {
  operatorChatUpdateRequestSchema,
  operatorUserUpdateRequestSchema,
  type OperatorChat,
  type OperatorChatMember,
  type OperatorMessage,
  type OperatorUser,
} from "@assistant-hub/contracts";
import { internalTokenGuard } from "@assistant-hub/service";
import { Hono } from "hono";

import type { ChatDb } from "./db";
import {
  getMediaForMessages,
  getMessageById,
  getThreadListing,
  getUserById,
  listThreadListings,
  listThreadMembers,
  listThreadMessages,
  listUsers,
  updateThreadLanguage,
  updateThreadNotes,
  updateUserAliases,
  updateUserLanguage,
  type ThreadListing,
} from "./store";
import type { ChatMediaRow, ChatMessageRow, ChatUserRow, ThreadRow } from "../store/schema";

/**
 * This app's HTTP surface — the same two zones every source app serves
 * (`apps/tg/src/api.ts` is the twin):
 *
 * - `/health` — liveness/readiness for compose and the dashboard.
 * - `/internal/*` — the API only the core reaches, through its proxy or its
 *   server code, behind the shared internal token.
 *
 * Slice A serves the operator listing/CRUD contract, so web users and threads
 * show up in the dashboard's aggregated directory beside the telegram ones.
 * Threads CRUD, the inbound half and the outbound sends land in later slices.
 *
 * A thread is this source's conversation shape: one human, one assistant
 * bound at creation. The contract's `kind` is therefore always `direct`, and
 * a thread's roster is its owner.
 */

export function createApi(input: { db: ChatDb; internalToken: string }): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    // Probe the real thing, not configuration — a reachable database is what
    // "ready" means for this service.
    try {
      await input.db.execute("select 1");
    } catch {
      return c.json({ ok: false, error: "database unreachable" }, 503);
    }
    return c.json({ ok: true });
  });

  const internal = new Hono();
  internal.use("*", internalTokenGuard(input.internalToken));

  const toOperatorUser = (row: ChatUserRow): OperatorUser => ({
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
  });

  const toOperatorChat = (listing: ThreadListing): OperatorChat => ({
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
  });

  const toOperatorChatMember = (member: {
    user: ChatUserRow;
    memberSinceAt: Date;
    lastSeenAt: Date;
  }): OperatorChatMember => ({
    ...toOperatorUser(member.user),
    memberSinceAt: member.memberSinceAt.toISOString(),
    lastSeenAt: member.lastSeenAt.toISOString(),
  });

  const toOperatorMessage = (
    row: ChatMessageRow,
    thread: ThreadRow,
    attached: ChatMediaRow | null,
  ): OperatorMessage => ({
    sourceMessageId: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    // Every human line in a thread is the thread's owner.
    userId: row.role === "assistant" ? null : thread.userId,
    content: row.content,
    replyToSourceMessageId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
    sentAt: row.sentAt.toISOString(),
    // Web messages are not editable, and reactions have no web analogue.
    editedAt: null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    botReaction: null,
    media: attached
      ? {
          kind: attached.kind,
          status: attached.status as "pending" | "described" | "unavailable",
          description: attached.description,
        }
      : null,
  });

  internal.get("/users", async (c) => {
    const rows = await listUsers(input.db);
    return c.json({ users: rows.map(toOperatorUser) });
  });

  internal.get("/users/:userId", async (c) => {
    const row = await getUserById(input.db, c.req.param("userId"));
    if (!row) return c.json({ error: { message: "user not found" } }, 404);
    return c.json({ user: toOperatorUser(row) });
  });

  internal.patch("/users/:userId", async (c) => {
    const parsed = operatorUserUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "aliases or language is required" } }, 400);
    }
    const userId = c.req.param("userId");
    const row =
      "aliases" in parsed.data
        ? await updateUserAliases(input.db, userId, parsed.data.aliases)
        : await updateUserLanguage(input.db, userId, parsed.data.language);
    if (!row) return c.json({ error: { message: "user not found" } }, 404);
    return c.json({ user: toOperatorUser(row) });
  });

  internal.get("/chats", async (c) => {
    const listings = await listThreadListings(input.db);
    return c.json({ chats: listings.map(toOperatorChat) });
  });

  internal.get("/chats/:chatId", async (c) => {
    const listing = await getThreadListing(input.db, c.req.param("chatId"));
    if (!listing) return c.json({ error: { message: "thread not found" } }, 404);
    return c.json({ chat: toOperatorChat(listing) });
  });

  internal.get("/chats/:chatId/members", async (c) => {
    const members = await listThreadMembers(input.db, c.req.param("chatId"));
    return c.json({ members: members.map(toOperatorChatMember) });
  });

  internal.patch("/chats/:chatId", async (c) => {
    const parsed = operatorChatUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "notes or language is required" } }, 400);
    }
    const threadId = c.req.param("chatId");
    const row =
      "notes" in parsed.data
        ? await updateThreadNotes(input.db, threadId, parsed.data.notes)
        : await updateThreadLanguage(input.db, threadId, parsed.data.language);
    if (!row) return c.json({ error: { message: "thread not found" } }, 404);
    const listing = await getThreadListing(input.db, threadId);
    return c.json({ chat: listing ? toOperatorChat(listing) : null });
  });

  internal.get("/chats/:chatId/messages", async (c) => {
    const threadId = c.req.param("chatId");
    const listing = await getThreadListing(input.db, threadId);
    if (!listing) return c.json({ error: { message: "thread not found" } }, 404);
    const rows = await listThreadMessages(input.db, threadId);
    const media = await getMediaForMessages(
      input.db,
      rows.map((row) => row.id),
    );
    return c.json({
      messages: rows.map((row) =>
        toOperatorMessage(row, listing.thread, media.get(row.id) ?? null),
      ),
    });
  });

  internal.get("/chats/:chatId/messages/:messageId", async (c) => {
    const threadId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    const listing = await getThreadListing(input.db, threadId);
    if (!listing) return c.json({ error: { message: "thread not found" } }, 404);
    const row = await getMessageById(input.db, threadId, messageId);
    if (!row) return c.json({ error: { message: "message not found" } }, 404);
    const media = await getMediaForMessages(input.db, [row.id]);
    return c.json({ message: toOperatorMessage(row, listing.thread, media.get(row.id) ?? null) });
  });

  app.route("/internal", internal);
  return app;
}
