import {
  chatPostMessageRequestSchema,
  chatThreadCreateRequestSchema,
  internalMediaDescribeRequestSchema,
  internalSendFileRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  chatThreadUpdateRequestSchema,
  internalSendMessageRequestSchema,
  internalSetTitleRequestSchema,
  operatorChatUpdateRequestSchema,
  operatorUserUpdateRequestSchema,
  type ChatThread,
  type ChatThreadMessage,
  type InboundMessageEvent,
  type OperatorChat,
  type OperatorChatMember,
  type OperatorMessage,
  type OperatorUser,
} from "@assistant-hub/contracts";
import { internalTokenGuard, serveMcp } from "@assistant-hub/service";
import { Hono } from "hono";

import type { ChatDb } from "./db";
import { postThreadMessage } from "./inbound";
import { createChatMcpServer } from "./mcp";
import {
  countPendingMedia,
  describeOnInsert,
  insertMedia,
  getMediaById,
  getMediaByMessage,
  getMediaForMessages as getThreadMedia,
  listPendingMediaRefs,
  listRecentMedia,
  markDescribed,
  type StoredChatMedia,
} from "./media";
import type { ThreadTurns } from "./turns";
import {
  appendMessage,
  createThread,
  deleteThread,
  getMediaForMessages,
  getMessageById,
  getOrCreateOperatorUser,
  getThreadById,
  getThreadListing,
  getUserById,
  listLiveMessages,
  listThreadListings,
  listThreadMembers,
  listThreadMessages,
  listUsers,
  markMessageDeleted,
  renameThread,
  setGeneratedTitle,
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
 * Three groups of endpoints, and the difference between the last two is who
 * is speaking:
 *
 * - the shared operator listing/CRUD contract (`/internal/users`,
 *   `/internal/chats/…`), so web users and threads show up in the dashboard's
 *   aggregated directory beside the telegram ones;
 * - the thread API (`/internal/threads/…`) — the chat experience itself: the
 *   operator's own view, creating and renaming threads, and posting what the
 *   HUMAN says, which starts a turn;
 * - the outbound port (`/internal/chats/:threadId/messages`, …) — what the
 *   CORE's tools call to put something in a thread, mirroring tg's send API
 *   so the same core-side port serves both sources.
 *
 * A thread is this source's conversation shape: one human, one assistant
 * bound at creation. The contract's `kind` is therefore always `direct`, and
 * a thread's roster is its owner.
 */

export function createApi(input: {
  db: ChatDb;
  internalToken: string;
  /**
   * Publish one inbound event as one queue job. Absent → posting a message
   * stores it and says so, rather than pretending a turn was started: a
   * silent no-turn is the failure mode that reads as "the bot ignored me".
   */
  enqueue?: (event: InboundMessageEvent) => Promise<void>;
  /** Ping the dashboard's live topics (the bus publisher, when there is one). */
  onThreadsChanged?: () => void;
  /**
   * What the core is doing in each thread right now, kept by the lifecycle
   * consumer. Absent → threads simply report no running turn, which is the
   * honest answer for a service with no bus attached.
   */
  turns?: ThreadTurns;
}): Hono {
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


  // ---- The thread API: the chat experience itself ------------------------

  const toChatThread = (listing: ThreadListing): ChatThread => ({
    id: listing.thread.id,
    assistantId: listing.thread.assistantId,
    name: listing.thread.name,
    titleProvisional: listing.thread.titleProvisional,
    userId: listing.thread.userId,
    messageCount: listing.messageCount,
    lastMessageAt: listing.lastMessageAt ? listing.lastMessageAt.toISOString() : null,
    createdAt: listing.thread.createdAt.toISOString(),
    updatedAt: listing.thread.updatedAt.toISOString(),
  });

  const toThreadMessage = (
    row: ChatMessageRow,
    attached?: { id: string; kind: string; status: string; description: string | null } | null,
  ): ChatThreadMessage => ({
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
  });

  /** The operator's own chat user, created on first contact. */
  internal.get("/operator-user", async (c) => {
    const user = await getOrCreateOperatorUser(input.db);
    return c.json({ user: { id: user.id, name: user.name } });
  });

  internal.get("/threads", async (c) => {
    const listings = await listThreadListings(input.db);
    return c.json({ threads: listings.map(toChatThread) });
  });

  internal.post("/threads", async (c) => {
    const parsed = chatThreadCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "assistantId and name are required" } }, 400);
    }
    // Single-operator system: a thread started from the dashboard belongs to
    // the operator's own chat user.
    const user = await getOrCreateOperatorUser(input.db);
    const thread = await createThread(input.db, {
      userId: user.id,
      assistantId: parsed.data.assistantId,
      name: parsed.data.name ?? null,
    });
    input.onThreadsChanged?.();
    return c.json(
      { thread: toChatThread({ thread, messageCount: 0, lastMessageAt: null }) },
      201,
    );
  });

  internal.get("/threads/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    const listing = await getThreadListing(input.db, threadId);
    if (!listing) return c.json({ error: { message: "thread not found" } }, 404);
    const rows = await listLiveMessages(input.db, threadId);
    const attached = await getThreadMedia(
      input.db,
      rows.map((row) => row.id),
    );
    const turn = input.turns?.get(threadId) ?? null;
    return c.json({
      thread: toChatThread(listing),
      messages: rows.map((row) => toThreadMessage(row, attached.get(row.id) ?? null)),
      turn: turn
        ? {
            sourceMessageId: turn.sourceMessageId,
            activity: turn.activity,
            since: turn.since.toISOString(),
          }
        : null,
    });
  });

  internal.patch("/threads/:threadId", async (c) => {
    const parsed = chatThreadUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "name is required" } }, 400);
    // The assistant is fixed at creation (PLAN.md) — only the name moves.
    const row = await renameThread(input.db, c.req.param("threadId"), parsed.data.name);
    if (!row) return c.json({ error: { message: "thread not found" } }, 404);
    input.onThreadsChanged?.();
    const listing = await getThreadListing(input.db, row.id);
    if (!listing) return c.json({ error: { message: "thread not found" } }, 404);
    return c.json({ thread: toChatThread(listing) });
  });

  internal.delete("/threads/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    input.turns?.clear(threadId);
    const deleted = await deleteThread(input.db, threadId);
    if (!deleted) return c.json({ error: { message: "thread not found" } }, 404);
    input.onThreadsChanged?.();
    return c.json({ deleted: true });
  });

  /** The human speaks: store it, then start the turn. */
  internal.post("/threads/:threadId/messages", async (c) => {
    const parsed = chatPostMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "text is required" } }, 400);
    if (!input.enqueue) {
      // No queue configured: refuse rather than store a message no assistant
      // will ever see — the operator gets told, instead of waiting forever.
      return c.json(
        { error: { message: "the message queue is not configured — no turn can be started" } },
        503,
      );
    }
    const posted = await postThreadMessage({
      db: input.db,
      threadId: c.req.param("threadId"),
      text: parsed.data.text,
      image: parsed.data.image ?? null,
      audio: parsed.data.audio ?? null,
      enqueue: input.enqueue,
    });
    if (!posted) return c.json({ error: { message: "thread not found" } }, 404);
    input.onThreadsChanged?.();
    return c.json({
      message: toThreadMessage(posted.message, posted.media),
      correlationId: posted.correlationId,
    });
  });

  // ---- The outbound port: what the core's tools put in a thread -----------
  // Same paths and shapes as the tg app serves, so the core's per-source
  // outbound port is one client, not one per source.

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "text is required" } }, 400);
    const threadId = c.req.param("chatId");
    const thread = await getThreadById(input.db, threadId);
    if (!thread) return c.json({ error: { message: "thread not found" } }, 404);
    const stored = await appendMessage(input.db, {
      threadId,
      role: "assistant",
      content: parsed.data.text,
      replyToMessageId:
        parsed.data.replyToSourceMessageId != null
          ? Number(parsed.data.replyToSourceMessageId)
          : null,
    });
    input.onThreadsChanged?.();
    return c.json({ sourceMessageId: String(stored.id) });
  });

  /**
   * A voice reply: the core synthesized the audio, this stores it as an
   * assistant message with the spoken text as its content — that text is what
   * the transcript, the window and the next turn read, exactly as tg mirrors
   * the words rather than the bubble. `asVoice` is always true here: a
   * browser plays whatever it is given, so there is no refusal to fall back
   * from.
   */
  internal.post("/chats/:chatId/voice", async (c) => {
    const parsed = internalSendVoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "audioBase64 and text are required" } }, 400);
    }
    const threadId = c.req.param("chatId");
    const thread = await getThreadById(input.db, threadId);
    if (!thread) return c.json({ error: { message: "thread not found" } }, 404);
    const body = parsed.data;
    const stored = await appendMessage(input.db, {
      threadId,
      role: "assistant",
      content: body.text,
      replyToMessageId:
        body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null,
    });
    // The audio needs no describing — its words are the message's own text.
    await describeOnInsert(input.db, {
      messageId: stored.id,
      kind: "voice",
      mimeType: "audio/ogg",
      frames: [body.audioBase64],
      description: body.text,
    }).catch(() => null);
    input.onThreadsChanged?.();
    return c.json({ sourceMessageId: String(stored.id), asVoice: true });
  });

  /**
   * Generated images. One message per image, each carrying the picture as
   * `pending` media so the vision pass describes what the assistant itself
   * put in the thread (tg does the same).
   */
  internal.post("/chats/:chatId/photos", async (c) => {
    const parsed = internalSendPhotosRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "images are required" } }, 400);
    const threadId = c.req.param("chatId");
    const thread = await getThreadById(input.db, threadId);
    if (!thread) return c.json({ error: { message: "thread not found" } }, 404);
    const delivered: Array<{ sourceMessageId: string; stored: boolean }> = [];
    for (const image of parsed.data.images) {
      const message = await appendMessage(input.db, {
        threadId,
        role: "assistant",
        content: "",
      });
      const media = await insertMedia(input.db, {
        messageId: message.id,
        kind: "image",
        mimeType: "image/png",
        frames: [image],
      }).catch(() => null);
      delivered.push({ sourceMessageId: String(message.id), stored: media !== null });
    }
    input.onThreadsChanged?.();
    return c.json({ delivered });
  });

  /**
   * A file the assistant produced (a browser-run download). The caption is
   * the message's text; the bytes are kept as media so the thread can offer
   * them back — a web thread has nowhere else to put a file.
   */
  internal.post("/chats/:chatId/files", async (c) => {
    const parsed = internalSendFileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "dataBase64 is required" } }, 400);
    const threadId = c.req.param("chatId");
    const thread = await getThreadById(input.db, threadId);
    if (!thread) return c.json({ error: { message: "thread not found" } }, 404);
    const body = parsed.data;
    const message = await appendMessage(input.db, {
      threadId,
      role: "assistant",
      content: body.caption ?? body.filename,
    });
    // Nothing to describe: the caption already says what it is, and a
    // pending row would send the backfill after a file it cannot read.
    await describeOnInsert(input.db, {
      messageId: message.id,
      kind: "file",
      mimeType: body.mime ?? null,
      frames: [body.dataBase64],
      description: body.filename,
    }).catch(() => null);
    input.onThreadsChanged?.();
    return c.json({ sourceMessageId: String(message.id) });
  });

  /**
   * Name a thread from what was said in it — the core's answer to this app's
   * `titleProvisional` flag. Ignored once the thread has a name someone
   * chose: a late-arriving generated title must not overwrite it.
   */
  internal.put("/chats/:chatId/title", async (c) => {
    const parsed = internalSetTitleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "title is required" } }, 400);
    const row = await setGeneratedTitle(input.db, c.req.param("chatId"), parsed.data.title);
    if (!row) {
      const current = await getThreadById(input.db, c.req.param("chatId"));
      if (!current) return c.json({ error: { message: "thread not found" } }, 404);
      return c.json({ title: current.name });
    }
    input.onThreadsChanged?.();
    return c.json({ title: row.name });
  });

  internal.delete("/chats/:chatId/messages/:messageId", async (c) => {
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    const deleted = await markMessageDeleted(input.db, c.req.param("chatId"), messageId);
    if (deleted) input.onThreadsChanged?.();
    return c.json({ deleted });
  });


  // ---- Media: what the core's vision pipeline reads and writes back -------
  // Same paths and shapes as the tg app serves, so the core's per-source
  // media port is one client. Frames are kept after describing here (see
  // `media.ts`): a web thread is the only archive its images have.

  const toInternalMedia = (row: StoredChatMedia) => ({
    id: row.id,
    chatId: row.threadId,
    sourceMessageId: String(row.messageId),
    kind: row.kind,
    status: row.status as "pending" | "described" | "unavailable",
    description: row.description,
    // A browser upload carries no describe hint of its own.
    visionHint: null,
    mimeType: row.mimeType,
    // Bytes travel with a PENDING row only — that is what the describe pass
    // needs, and a listing of a hundred described rows must not ship a
    // hundred pictures. The thread view fetches one by id when it renders it.
    frames: row.status === "pending" ? row.frames : [],
    createdAt: row.createdAt.toISOString(),
    describedAt: row.describedAt ? row.describedAt.toISOString() : null,
  });

  internal.get("/chats/:chatId/messages/:messageId/media", async (c) => {
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    const row = await getMediaByMessage(input.db, c.req.param("chatId"), messageId);
    return c.json({ media: row ? toInternalMedia(row) : null });
  });

  // Specific media routes before `/media/:id` — Hono matches in order.
  internal.get("/media/pending", async (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const [refs, total] = await Promise.all([
      listPendingMediaRefs(input.db, Number.isFinite(limit) ? limit : 20),
      countPendingMedia(input.db),
    ]);
    return c.json({
      media: refs.map((ref) => ({
        id: ref.id,
        chatId: ref.threadId,
        sourceMessageId: String(ref.messageId),
      })),
      total,
    });
  });

  internal.get("/media/recent", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = await listRecentMedia(input.db, Number.isFinite(limit) ? limit : 100);
    return c.json({ media: rows.map(toInternalMedia) });
  });

  internal.get("/media/:id", async (c) => {
    const row = await getMediaById(input.db, c.req.param("id"));
    return c.json({ media: row ? toInternalMedia(row) : null });
  });

  /**
   * The picture itself, for rendering: one image, as bytes, whatever its
   * describe status. This is why the frames are kept — a thread showing an
   * image the operator sent is the whole point of uploading it.
   */
  internal.get("/media/:id/bytes", async (c) => {
    const row = await getMediaById(input.db, c.req.param("id"));
    const frame = row?.frames[0];
    if (!row || !frame) return c.json({ error: { message: "media not found" } }, 404);
    return c.body(Buffer.from(frame, "base64"), 200, {
      "content-type": row.mimeType ?? "image/jpeg",
      // Immutable: a media row's bytes never change once stored.
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  internal.put("/media/:id/description", async (c) => {
    const parsed = internalMediaDescribeRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "description is required" } }, 400);
    }
    const id = c.req.param("id");
    const updated = await markDescribed(input.db, id, parsed.data.description);
    if (updated) {
      input.onThreadsChanged?.();
      return c.json({ updated: true, media: toInternalMedia(updated) });
    }
    // Not pending any more: a concurrent pass won — serve the stored winner
    // (the shared contract), or 404 for an unknown id.
    const current = await getMediaById(input.db, id);
    if (!current) return c.json({ error: { message: "media not found" } }, 404);
    return c.json({ updated: false, media: toInternalMedia(current) });
  });

  // This app's own MCP server (Phase 5): the core reaches it as a managed
  // tool connection, with the same shared secret the internal API takes. The
  // turn each call belongs to arrives as MCP `_meta`, so a tool never takes a
  // thread id from the model.
  const mcp = new Hono();
  mcp.use("*", internalTokenGuard(input.internalToken));
  mcp.all("/", (c) =>
    serveMcp(c, () =>
      createChatMcpServer({ db: input.db, onThreadsChanged: input.onThreadsChanged }),
    ),
  );

  app.route("/internal", internal);
  app.route("/mcp", mcp);
  return app;
}
