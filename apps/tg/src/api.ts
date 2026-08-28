import { randomUUID } from "node:crypto";

import {
  internalFeedbackPatchRequestSchema,
  internalMediaDescribeRequestSchema,
  internalSendFileRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  operatorChatUpdateRequestSchema,
  operatorConnectionCreateRequestSchema,
  operatorConnectionUpdateRequestSchema,
  operatorSourceSettingsUpdateRequestSchema,
  operatorUserUpdateRequestSchema,
  type InternalMedia,
  type InternalSentPhotosResponse,
  type OperatorChat,
  type OperatorChatMember,
  type OperatorConnection,
  type OperatorMessage,
  type OperatorUser,
} from "@assistant-hub/contracts";
import {
  contentBucketUnitSchema,
  contentImportRequestSchema,
  contentIndexRowsRequestSchema,
  contentReplaceSummariesRequestSchema,
  contentSearchMessagesRequestSchema,
  contentSearchSummariesRequestSchema,
} from "@assistant-hub/contracts";
import { internalTokenGuard, serveMcp } from "@assistant-hub/service";
import { Hono, type Context } from "hono";

import { recordAssistantMessage, type CrossFeed } from "./cross-feed";
import type { TgDb } from "./db";
import type { BotManager, ConnectionStatus } from "./bot-manager";
import { createTgMcpServer } from "./mcp";
import {
  clearMessageIndex,
  countEmbeddedMessages,
  countMessagesNeedingIndex,
  listMessagesNeedingIndex,
  upsertMessageIndex,
} from "./content/index-store";
import {
  getMessageAvailability,
  getMessageSeries,
  getNewUserSeries,
  getTopUsers,
  listChatHourCounts,
} from "./content/analytics";
import { searchMessagesHybrid, searchSummariesHybrid } from "./content/search";
import {
  countSummariesByChat,
  listChatDayCounts,
  listChatSummaries,
  replaceSummariesForDay,
} from "./content/summaries";
import {
  getFeedback as getFeedbackById,
  listFeedbacks,
  listUnincorporatedFeedbacks,
  patchFeedback,
  type FeedbackRecord,
} from "./feedback/store";
import { formatUserLabel } from "./format";
import { ingestGeneratedImage } from "./media/ingest";
import {
  countPendingMedia,
  getMediaByMessage,
  getMediaById,
  listPendingMediaRefs,
  listRecentMedia,
  markDescribed,
} from "./media/store";
import type { StoredMedia } from "./media/types";
import type { SentMessage, TgOutbound } from "./outbound";
import {
  appendMessagesBulk,
  deleteConnection,
  filterMirroredMessageIds,
  getConnection,
  getMessageByTelegramId,
  getMessagesByTelegramIds,
  getMessagesInWindow,
  getTgSettings,
  getUserById,
  insertConnection,
  listChatListings,
  listChatMemberListings,
  listChatMessages,
  listConnections,
  listUsers,
  getMediaForMessages,
  markMessageDeleted,
  setOwner,
  updateChatLanguage,
  updateChatNotes,
  updateConnection,
  updateUserAliases,
  updateUserLanguage,
  type ChatListing,
  type ChatMemberListing,
} from "./store";
import type { ConnectionRow, MessageRow, UserRow } from "../store/schema";
import { findMessageRefs } from "./telegram";

/**
 * This app's HTTP surface (Hono — user decision, 2026-08-23). Two zones:
 *
 * - `/health` — liveness/readiness for compose and the dashboard.
 * - `/internal/*` — the API only the core reaches (through its proxy /
 *   server code), authenticated by the shared `INTERNAL_API_TOKEN` header
 *   (user decision, 2026-08-23: shared secret, not network topology —
 *   dev runs everything on localhost). The operator listing/CRUD API and
 *   the media/search/summaries endpoints land here slice by slice.
 *
 * The outbound sends (slice D) are the calls that need something back from
 * this app (a delivered id, a mirror-checked refusal) or carry bytes —
 * voice replies, generated images, acknowledgements, deletes, reactions.
 * Plain text replies keep travelling as reply-delivery bus events; these
 * endpoints mirror what they deliver the same way the delivery consumer
 * does.
 */

export function createApi(input: {
  db: TgDb;
  manager: Pick<
    BotManager,
    "statuses" | "senderFor" | "reconcileConnection" | "removeConnection"
  >;
  internalToken: string;
  /**
   * Hands what these endpoints deliver to the chat's other assistants
   * (`cross-feed.ts`), exactly as the reply-delivery consumer does.
   */
  crossFeed?: CrossFeed;
}): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    // Probe the real thing, not configuration: the database answers, and the
    // poller states are reported as they are.
    try {
      await input.db.execute("select 1");
    } catch {
      return c.json({ ok: false, error: "database unreachable" }, 503);
    }
    return c.json({ ok: true, connections: input.manager.statuses() });
  });

  const internal = new Hono();
  internal.use("*", internalTokenGuard(input.internalToken));
  // ---- Operator listing/CRUD (slice D) ------------------------------------
  // The shared operator contract (`operator-api` in contracts): users,
  // chats, messages, connections, and this app's settings — what the
  // dashboard's users / groups / history / bot-control views aggregate
  // through the core proxy (which owns the operator session; this surface
  // trusts the internal token).

  const toOperatorUser = (row: UserRow): OperatorUser => ({
    id: row.userId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    label: formatUserLabel({
      userId: row.userId,
      username: row.username,
      firstName: row.firstName,
      lastName: row.lastName,
    }),
    aliases: row.aliases,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  const toOperatorChat = (listing: ChatListing): OperatorChat => ({
    id: listing.chatId,
    // Telegram encodes the kind in the sign: group ids are negative.
    kind: listing.chatId.startsWith("-") ? "group" : "direct",
    title: listing.chat?.title ?? null,
    type: listing.chat?.type ?? null,
    notes: listing.chat?.notes ?? null,
    language: listing.chat?.language ?? null,
    messageCount: listing.messageCount,
    memberCount: listing.memberCount,
    lastMessageAt: listing.lastMessageAt ? listing.lastMessageAt.toISOString() : null,
  });

  const toOperatorChatMember = (listing: ChatMemberListing): OperatorChatMember => ({
    ...toOperatorUser(listing.user),
    memberSinceAt: listing.memberSinceAt.toISOString(),
    lastSeenAt: listing.lastSeenAt.toISOString(),
  });

  const toOperatorMessage = (
    row: MessageRow,
    media: Map<number, { kind: string; description: string | null; status: string }>,
  ): OperatorMessage => {
    const attached = media.get(row.telegramMessageId) ?? null;
    return {
      sourceMessageId: String(row.telegramMessageId),
      role: row.role === "assistant" ? "assistant" : "user",
      userId: row.userId,
      content: row.content,
      replyToSourceMessageId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
      sentAt: row.sentAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      botReaction: row.botReaction,
      media: attached
        ? {
            kind: attached.kind,
            status: attached.status as "pending" | "described" | "unavailable",
            description: attached.description,
          }
        : null,
    };
  };

  const toOperatorConnection = (
    row: ConnectionRow,
    statuses: ConnectionStatus[],
  ): OperatorConnection => {
    const status = statuses.find((s) => s.connectionId === row.id) ?? null;
    return {
      id: row.id,
      assistantId: row.assistantId,
      enabled: row.enabled,
      // Enough to tell tokens apart, never the token (schema: secret).
      botTokenHint: row.botToken.slice(-4),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      status: status
        ? {
            state: status.state,
            username: status.username,
            since: status.since,
            error: status.error,
          }
        : null,
    };
  };

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
    const listings = await listChatListings(input.db);
    return c.json({ chats: listings.map(toOperatorChat) });
  });

  internal.get("/chats/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    const listings = await listChatListings(input.db);
    const listing = listings.find((l) => l.chatId === chatId);
    if (!listing) return c.json({ error: { message: "chat not found" } }, 404);
    return c.json({ chat: toOperatorChat(listing) });
  });

  internal.get("/chats/:chatId/members", async (c) => {
    const listings = await listChatMemberListings(input.db, c.req.param("chatId"));
    return c.json({ members: listings.map(toOperatorChatMember) });
  });

  internal.patch("/chats/:chatId", async (c) => {
    const parsed = operatorChatUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "notes or language is required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const row =
      "notes" in parsed.data
        ? await updateChatNotes(input.db, chatId, parsed.data.notes)
        : await updateChatLanguage(input.db, chatId, parsed.data.language);
    if (!row) return c.json({ error: { message: "chat not found" } }, 404);
    const listings = await listChatListings(input.db);
    const listing = listings.find((l) => l.chatId === chatId);
    return c.json({
      chat: listing ? toOperatorChat(listing) : null,
    });
  });

  internal.get("/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    const rows = await listChatMessages(input.db, chatId);
    const media = await getMediaForMessages(
      input.db,
      chatId,
      rows.map((row) => row.telegramMessageId),
    );
    return c.json({ messages: rows.map((row) => toOperatorMessage(row, media)) });
  });

  internal.get("/chats/:chatId/messages/:messageId", async (c) => {
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    // Operator read — not assistant-aware yet (a DM lookup spans both
    // streams; the content-plane scoping is a recorded follow-up).
    const row = await getMessageByTelegramId(input.db, chatId, messageId, null);
    if (!row) return c.json({ message: null });
    const media = await getMediaForMessages(input.db, chatId, [messageId]);
    return c.json({ message: toOperatorMessage(row, media) });
  });

  // ---- Feedback rows (slice: the swap) ------------------------------------
  // The raw material the core's learning jobs read and stamp: the listing
  // (dashboard + fold backlogs) and the write-backs (model, reflection,
  // fold-version stamps). Collection happens in this app (the flows).

  const toInternalFeedback = (record: FeedbackRecord) => ({
    id: record.id,
    chatId: record.chatId,
    sourceMessageId: String(record.telegramMessageId),
    userId: record.userId,
    reaction: record.reaction,
    feedback: record.feedback,
    status: record.status,
    topic: record.topic,
    model: record.model,
    reflection: record.reflection,
    reflectionModel: record.reflectionModel,
    prefsVersion: record.prefsVersion,
    correctionsVersion: record.correctionsVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });

  internal.get("/feedbacks", async (c) => {
    const needs = c.req.query("needs");
    if (needs != null && needs !== "prefs" && needs !== "corrections") {
      return c.json({ error: { message: "needs must be prefs or corrections" } }, 400);
    }
    const rows = needs
      ? await listUnincorporatedFeedbacks(input.db, needs)
      : await listFeedbacks(input.db);
    return c.json({ feedbacks: rows.map(toInternalFeedback) });
  });

  internal.get("/feedbacks/:id", async (c) => {
    const record = await getFeedbackById(input.db, c.req.param("id"));
    return c.json({ feedback: record ? toInternalFeedback(record) : null });
  });

  internal.patch("/feedbacks/:id", async (c) => {
    const parsed = internalFeedbackPatchRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "a non-empty write-back patch is required" } }, 400);
    }
    const record = await patchFeedback(input.db, c.req.param("id"), parsed.data);
    if (!record) return c.json({ error: { message: "feedback not found" } }, 404);
    return c.json({ feedback: toInternalFeedback(record) });
  });

  internal.get("/connections", async (c) => {
    const rows = await listConnections(input.db);
    const statuses = input.manager.statuses();
    return c.json({ connections: rows.map((row) => toOperatorConnection(row, statuses)) });
  });

  internal.post("/connections", async (c) => {
    const parsed = operatorConnectionCreateRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "assistantId and botToken are required" } }, 400);
    }
    let row: ConnectionRow;
    try {
      row = await insertConnection(input.db, { id: randomUUID(), ...parsed.data });
    } catch {
      // The unique index: one bot per assistant.
      return c.json({ error: { message: "this assistant already has a connection" } }, 409);
    }
    await input.manager.reconcileConnection(row);
    return c.json({ connection: toOperatorConnection(row, input.manager.statuses()) });
  });

  internal.patch("/connections/:id", async (c) => {
    const parsed = operatorConnectionUpdateRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "botToken or enabled is required" } }, 400);
    }
    const row = await updateConnection(input.db, c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: { message: "connection not found" } }, 404);
    await input.manager.reconcileConnection(row);
    return c.json({ connection: toOperatorConnection(row, input.manager.statuses()) });
  });

  internal.delete("/connections/:id", async (c) => {
    const row = await deleteConnection(input.db, c.req.param("id"));
    if (!row) return c.json({ error: { message: "connection not found" } }, 404);
    await input.manager.removeConnection(row.id);
    return c.json({ connection: toOperatorConnection(row, []) });
  });

  internal.get("/settings", async (c) => {
    return c.json({ settings: await getTgSettings(input.db) });
  });

  internal.put("/settings", async (c) => {
    const parsed = operatorSourceSettingsUpdateRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "ownerUsername is required (or null)" } }, 400);
    }
    await setOwner(input.db, parsed.data);
    return c.json({ settings: await getTgSettings(input.db) });
  });

  // The media surface (slice B): the core's vision/voice features read a
  // pending row's bytes here, run the describe/transcribe model, and write
  // the text back — this app then drops the bytes.
  internal.get("/chats/:chatId/messages/:messageId/media", async (c) => {
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    const media = await getMediaByMessage(input.db, chatId, messageId);
    return c.json({ media: media ? toInternalMedia(media) : null });
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
        chatId: ref.chatId,
        sourceMessageId: String(ref.telegramMessageId),
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
    const media = await getMediaById(input.db, c.req.param("id"));
    return c.json({ media: media ? toInternalMedia(media) : null });
  });

  internal.put("/media/:id/description", async (c) => {
    const parsed = internalMediaDescribeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "description is required" } }, 400);
    }
    const id = c.req.param("id");
    const updated = await markDescribed(input.db, id, parsed.data.description);
    if (updated) {
      return c.json({ updated: true, media: toInternalMedia(updated) });
    }
    // Not pending any more: a concurrent pass won — serve the stored winner
    // (the in-process `markDescribed` contract), or 404 for an unknown id.
    const current = await getMediaById(input.db, id);
    if (!current) return c.json({ error: { message: "media not found" } }, 404);
    return c.json({ updated: false, media: toInternalMedia(current) });
  });

  // ---- Conversation content (the swap) ------------------------------------
  // The mirror, search index, and summaries live in this store; the core's
  // content features (history tools, summarization, indexing, dashboard
  // search) read and write them here. The SQL runs beside the data; the
  // core supplies query text and embedding vectors.

  const toContentMessage = (
    row: MessageRow,
    media: Map<number, { kind: string; description: string | null; status: string }>,
  ) => {
    const attached = media.get(row.telegramMessageId) ?? null;
    return {
      id: row.id,
      chatId: row.chatId,
      sourceMessageId: String(row.telegramMessageId),
      role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
      userId: row.userId,
      content: row.content,
      replyToSourceMessageId: row.replyToMessageId != null ? String(row.replyToMessageId) : null,
      sentAt: row.sentAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      botReaction: row.botReaction,
      createdAt: row.createdAt.toISOString(),
      media: attached
        ? {
            kind: attached.kind,
            status: attached.status as "pending" | "described" | "unavailable",
            description: attached.description,
          }
        : null,
    };
  };

  internal.get("/chats/:chatId/content-messages", async (c) => {
    const chatId = c.req.param("chatId");
    const idsParam = c.req.query("ids");
    const from = c.req.query("from");
    const to = c.req.query("to");
    let rows: MessageRow[];
    if (idsParam != null) {
      const ids = idsParam
        .split(",")
        .map((raw) => Number(raw))
        .filter((id) => Number.isFinite(id));
      rows = await getMessagesByTelegramIds(input.db, chatId, ids);
    } else if (from != null && to != null) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return c.json({ error: { message: "from/to must be ISO instants" } }, 400);
      }
      rows = await getMessagesInWindow(input.db, chatId, {
        from: fromDate,
        to: toDate,
        endExclusive: c.req.query("endExclusive") === "true",
      });
    } else {
      rows = await listChatMessages(input.db, chatId);
    }
    const media = await getMediaForMessages(
      input.db,
      chatId,
      rows.map((row) => row.telegramMessageId),
    );
    return c.json({ messages: rows.map((row) => toContentMessage(row, media)) });
  });

  internal.post("/chats/:chatId/messages/import", async (c) => {
    const parsed = contentImportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "messages are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const inserted = await appendMessagesBulk(
      input.db,
      parsed.data.messages.map((m) => ({
        chatId,
        telegramMessageId: Number(m.sourceMessageId),
        role: m.role,
        userId: m.userId ?? null,
        content: m.content,
        replyToMessageId: m.replyToSourceMessageId != null ? Number(m.replyToSourceMessageId) : null,
        sentAt: new Date(m.sentAt),
        editedAt: m.editedAt ? new Date(m.editedAt) : null,
        deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
      })),
    );
    return c.json({ inserted });
  });

  internal.get("/messages/day-counts", async (c) => {
    const timeZone = c.req.query("tz");
    const before = c.req.query("before");
    if (!timeZone || !before) {
      return c.json({ error: { message: "tz and before are required" } }, 400);
    }
    const days = await listChatDayCounts(input.db, { timeZone, before });
    return c.json({ days });
  });

  /**
   * Parse the shared analytics query surface: a half-open UTC range
   * (`to` exclusive), a bucket unit, and a timezone. Null → a 400 was sent.
   */
  const analyticsScope = (c: Context) => {
    const from = new Date(c.req.query("from") ?? "");
    const to = new Date(c.req.query("to") ?? "");
    const unit = contentBucketUnitSchema.safeParse(c.req.query("unit"));
    const timeZone = c.req.query("tz");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !unit.success || !timeZone) {
      return null;
    }
    return { fromUtc: from, toUtc: to, unit: unit.data, timeZone };
  };
  const ANALYTICS_SCOPE_ERROR = { error: { message: "from, to, unit and tz are required" } };

  internal.get("/analytics/message-series", async (c) => {
    const scope = analyticsScope(c);
    if (!scope) return c.json(ANALYTICS_SCOPE_ERROR, 400);
    const rows = await getMessageSeries(input.db, {
      ...scope,
      chatId: c.req.query("chatId") || null,
      userId: c.req.query("userId") || null,
    });
    return c.json({ rows });
  });

  internal.get("/analytics/new-user-series", async (c) => {
    const scope = analyticsScope(c);
    if (!scope) return c.json(ANALYTICS_SCOPE_ERROR, 400);
    return c.json({ rows: await getNewUserSeries(input.db, scope) });
  });

  internal.get("/analytics/top-users", async (c) => {
    const from = new Date(c.req.query("from") ?? "");
    const to = new Date(c.req.query("to") ?? "");
    const limit = Number(c.req.query("limit") ?? "10");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !Number.isFinite(limit)) {
      return c.json({ error: { message: "from, to and limit are required" } }, 400);
    }
    const rows = await getTopUsers(input.db, {
      fromUtc: from,
      toUtc: to,
      chatId: c.req.query("chatId") || null,
      limit,
    });
    return c.json({ rows });
  });

  internal.get("/analytics/availability", async (c) => {
    const scope = analyticsScope(c);
    if (!scope) return c.json(ANALYTICS_SCOPE_ERROR, 400);
    const buckets = await getMessageAvailability(input.db, {
      ...scope,
      chatId: c.req.query("chatId") || null,
    });
    return c.json({ buckets });
  });

  internal.get("/analytics/hour-counts", async (c) => {
    const timeZone = c.req.query("tz");
    if (!timeZone) return c.json({ error: { message: "tz is required" } }, 400);
    const fromRaw = c.req.query("from");
    const fromUtc = fromRaw ? new Date(fromRaw) : undefined;
    if (fromUtc && Number.isNaN(fromUtc.getTime())) {
      return c.json({ error: { message: "from must be an ISO instant" } }, 400);
    }
    const hours = await listChatHourCounts(input.db, { timeZone, fromUtc });
    return c.json({ hours });
  });

  internal.put("/chats/:chatId/summaries/:date", async (c) => {
    const parsed = contentReplaceSummariesRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "topics are required" } }, 400);
    }
    const stored = await replaceSummariesForDay(input.db, {
      chatId: c.req.param("chatId"),
      summaryDate: c.req.param("date"),
      topics: parsed.data.topics,
    });
    return c.json({ summaries: stored });
  });

  internal.get("/chats/:chatId/summaries", async (c) => {
    const limit = Number(c.req.query("limit") ?? "200");
    const stored = await listChatSummaries(
      input.db,
      c.req.param("chatId"),
      Number.isFinite(limit) ? limit : 200,
      c.req.query("date") || undefined,
    );
    return c.json({ summaries: stored });
  });

  internal.get("/summaries/counts", async (c) => {
    const counts = await countSummariesByChat(input.db);
    return c.json({
      counts: [...counts.entries()].map(([chatId, topicCount]) => ({ chatId, topicCount })),
    });
  });

  internal.post("/search/messages", async (c) => {
    const parsed = contentSearchMessagesRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "a search request is required" } }, 400);
    }
    const matches = await searchMessagesHybrid(input.db, parsed.data);
    return c.json({
      matches: matches.map((match) => ({
        id: match.id,
        chatId: match.chatId,
        sourceMessageId: String(match.telegramMessageId),
        role: match.role,
        userId: match.userId,
        content: match.content,
        replyToSourceMessageId:
          match.replyToMessageId != null ? String(match.replyToMessageId) : null,
        sentAt: match.sentAt,
        editedAt: match.editedAt,
        // The pools only ever select visible rows, so a hit is never deleted.
        deletedAt: null,
        botReaction: match.botReaction,
        createdAt: match.createdAt,
        indexedContent: match.indexedContent,
        mediaKind: match.mediaKind,
        score: match.score,
      })),
    });
  });

  internal.post("/search/summaries", async (c) => {
    const parsed = contentSearchSummariesRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: { message: "a search request is required" } }, 400);
    }
    const matches = await searchSummariesHybrid(input.db, parsed.data);
    return c.json({ matches });
  });

  internal.get("/index/due", async (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const [due, total] = await Promise.all([
      listMessagesNeedingIndex(input.db, Number.isFinite(limit) ? limit : 50),
      countMessagesNeedingIndex(input.db),
    ]);
    return c.json({
      messages: due.map((row) => ({
        chatId: row.chatId,
        sourceMessageId: String(row.telegramMessageId),
        content: row.content,
        media: row.media,
      })),
      total,
    });
  });

  internal.put("/index/rows", async (c) => {
    const parsed = contentIndexRowsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "rows are required" } }, 400);
    }
    await upsertMessageIndex(
      input.db,
      parsed.data.rows.map((row) => ({
        chatId: row.chatId,
        telegramMessageId: Number(row.sourceMessageId),
        content: row.content,
        embedding: row.embedding,
      })),
    );
    return c.json({ ok: true });
  });

  internal.post("/index/clear", async (c) => {
    const removed = await clearMessageIndex(input.db);
    return c.json({ removed });
  });

  internal.get("/index/embedded-count", async (c) => {
    const chatId = c.req.query("chatId");
    if (!chatId) return c.json({ error: { message: "chatId is required" } }, 400);
    const value = await countEmbeddedMessages(input.db, chatId);
    return c.json({ count: value });
  });

  // ---- Outbound sends (slice D) -------------------------------------------
  // The connection to send through: Phase 2 runs a single connection, so an
  // absent `assistantId` query resolves to "whichever runs" (the same
  // convention as the delivery consumer); Phase 3 threads assistants
  // through every caller. A send with no running connection is a 502 the
  // core relays — never a silent drop.

  // The sending assistant also scopes DM mirror rows/lookups: a DM's chat id
  // is the peer's user id, shared by every bot that talks to them.
  const assistantIdOf = (c: { req: { query: (k: string) => string | undefined } }): string | null =>
    c.req.query("assistantId") ?? null;

  const senderOf = (c: { req: { query: (k: string) => string | undefined } }): TgOutbound =>
    input.manager.senderFor(assistantIdOf(c));

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "text is required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    const replyToMessageId =
      body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null;
    const linkableMessageIds = await filterMirroredMessageIds(
      input.db,
      chatId,
      findMessageRefs(body.text),
      assistantIdOf(c),
    ).catch(() => []);
    let sent: SentMessage;
    try {
      sent = await senderOf(c).sendMessage(chatId, body.text, {
        replyToMessageId,
        threadId: body.threadId != null ? Number(body.threadId) : null,
        silent: body.silent,
        linkableMessageIds,
      });
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
    await recordAssistantMessage(
      input.db,
      {
        chatId,
        assistantId: assistantIdOf(c),
        telegramMessageId: sent.messageId,
        content: body.text,
        // What Telegram actually attached, not what was asked for.
        replyToMessageId: sent.replyToMessageId,
        sentAt: new Date(),
        threadId: body.threadId != null ? Number(body.threadId) : null,
        silent: body.silent,
      },
      input.crossFeed,
    ).catch(() => null);
    return c.json({ sourceMessageId: String(sent.messageId) });
  });

  internal.post("/chats/:chatId/voice", async (c) => {
    const parsed = internalSendVoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "audioBase64 and text are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    const replyToMessageId =
      body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null;
    const threadId = body.threadId != null ? Number(body.threadId) : null;
    const sender = senderOf(c);
    let sent: { messageId: number };
    let asVoice = true;
    try {
      sent = await sender.sendVoice(
        chatId,
        { base64: body.audioBase64, filename: "voice.ogg" },
        { replyToMessageId, threadId },
      );
    } catch {
      // The voice bubble was refused — the answer still arrives, as text
      // (v1's degradation, now owned by the source per the contract).
      try {
        sent = await sender.sendMessage(chatId, body.text, { replyToMessageId, threadId });
        asVoice = false;
      } catch (err) {
        return c.json({ error: { message: errorText(err) } }, 502);
      }
    }
    // The mirror records the spoken text — what history, search, and the
    // next turn's window read (v1: the text form is what is mirrored).
    await recordAssistantMessage(
      input.db,
      {
        chatId,
        assistantId: assistantIdOf(c),
        telegramMessageId: sent.messageId,
        content: body.text,
        replyToMessageId,
        sentAt: new Date(),
        threadId,
      },
      input.crossFeed,
    ).catch(() => null);
    return c.json({ sourceMessageId: String(sent.messageId), asVoice });
  });

  internal.post("/chats/:chatId/photos", async (c) => {
    const parsed = internalSendPhotosRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "images are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const threadId = parsed.data.threadId != null ? Number(parsed.data.threadId) : null;
    const sender = senderOf(c);
    // Best-effort per image, like v1's deliverGeneratedImages: a mirroring
    // failure must not turn a picture the user can see into a failed call,
    // and a send failure skips that image's rows entirely.
    const delivered: InternalSentPhotosResponse["delivered"] = [];
    for (const [index, base64] of parsed.data.images.entries()) {
      let sent: { messageId: number; fileId: string; fileUniqueId: string | null };
      try {
        sent = await sender.sendPhoto(
          chatId,
          { base64, filename: `image-${index + 1}.png` },
          { threadId },
        );
      } catch (err) {
        console.error(`Failed to deliver a generated image to ${chatId}:`, errorText(err));
        continue;
      }
      // The same pair of rows an incoming media message produces: a
      // media-only assistant mirror row (the picture IS the message) and a
      // pending media row keyed by the file id Telegram just minted.
      const mirrored = await recordAssistantMessage(
        input.db,
        {
          chatId,
          assistantId: assistantIdOf(c),
          telegramMessageId: sent.messageId,
          content: "",
          replyToMessageId: null,
          sentAt: new Date(),
          threadId,
        },
        input.crossFeed,
      ).catch(() => null);
      const stored =
        mirrored != null && sent.fileId
          ? await ingestGeneratedImage({
              db: input.db,
              chatId,
              telegramMessageId: sent.messageId,
              fileId: sent.fileId,
              fileUniqueId: sent.fileUniqueId,
              base64,
            })
          : null;
      delivered.push({ sourceMessageId: String(sent.messageId), stored: stored != null });
    }
    return c.json({ delivered });
  });

  internal.post("/chats/:chatId/files", async (c) => {
    const parsed = internalSendFileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "dataBase64 and filename are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    let sent: { messageId: number };
    try {
      sent = await senderOf(c).sendFile(
        chatId,
        { base64: body.dataBase64, filename: body.filename, mime: body.mime ?? null },
        {
          threadId: body.threadId != null ? Number(body.threadId) : null,
          caption: body.caption ?? null,
        },
      );
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
    // The caption is the delivered message's readable content (a browser-run
    // report riding its file) — that is what the mirror records.
    await recordAssistantMessage(
      input.db,
      {
        chatId,
        assistantId: assistantIdOf(c),
        telegramMessageId: sent.messageId,
        content: body.caption ?? "",
        replyToMessageId: null,
        sentAt: new Date(),
        threadId: body.threadId != null ? Number(body.threadId) : null,
      },
      input.crossFeed,
    ).catch(() => null);
    return c.json({ sourceMessageId: String(sent.messageId) });
  });

  internal.delete("/chats/:chatId/messages/:messageId", async (c) => {
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    // A refused delete (older than 48h, no running connection) is cosmetic
    // for every caller — the message simply stays standing.
    try {
      await senderOf(c).deleteMessage(chatId, messageId);
    } catch {
      return c.json({ deleted: false });
    }
    await markMessageDeleted(input.db, chatId, messageId, assistantIdOf(c)).catch(() => undefined);
    return c.json({ deleted: true });
  });

  // This app's own MCP server (Phase 5): the core reaches it as a managed
  // tool connection, with the same shared secret the internal API takes. The
  // turn each call belongs to arrives as MCP `_meta`, so a tool never takes a
  // chat id from the model.
  const mcp = new Hono();
  mcp.use("*", internalTokenGuard(input.internalToken));
  mcp.all("/", (c) => serveMcp(c, () => createTgMcpServer({ db: input.db, manager: input.manager })));

  app.route("/internal", internal);
  app.route("/mcp", mcp);

  return app;
}

function toInternalMedia(media: StoredMedia): InternalMedia {
  return {
    id: media.id,
    chatId: media.chatId,
    sourceMessageId: String(media.telegramMessageId),
    kind: media.kind,
    status: media.status as InternalMedia["status"],
    description: media.description,
    visionHint: media.visionHint,
    mimeType: media.mimeType,
    frames: media.frames,
    createdAt: media.createdAt.toISOString(),
    describedAt: media.describedAt ? media.describedAt.toISOString() : null,
  };
}
