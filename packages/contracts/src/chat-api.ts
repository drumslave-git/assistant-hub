import { z } from "zod";

/**
 * The web-chat app's own API shapes — what a thread is, and what talking in
 * one looks like. The chat service serves them, the core proxies them, and
 * `apps/chat/ui` renders them, so they live here rather than in any of the
 * three (the same reason tg's connection shapes do).
 *
 * The source-neutral listing/CRUD contract in `operator-api` still covers
 * threads as this source's *chats* — that is what the dashboard's aggregated
 * directory reads. These shapes are the chat experience itself: a thread
 * bound to an assistant, its transcript, and posting into it.
 */

/** One named thread, with the aggregates its list row shows. */
export const chatThreadSchema = z.object({
  id: z.string().min(1),
  /** The core-store assistant answering here, fixed at creation (PLAN.md). */
  assistantId: z.string().min(1),
  name: z.string().min(1),
  /** The chat user who owns the thread. */
  userId: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ChatThread = z.infer<typeof chatThreadSchema>;

/** Media attached to one line of a transcript, as the thread view renders it. */
export const chatMessageMediaSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(["pending", "described", "unavailable"]),
  /** The vision model's text, once it exists. */
  description: z.string().nullable(),
});

export type ChatMessageMedia = z.infer<typeof chatMessageMediaSchema>;

/** One line of a thread's transcript. */
export const chatThreadMessageSchema = z.object({
  /** Source-local message id, as a string (scoped refs and anchors use it). */
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  sentAt: z.string().min(1),
  /** The message this one answers, or null. */
  replyToId: z.string().nullable(),
  /** Media on this line, or null. The bytes are fetched by id when rendering. */
  media: chatMessageMediaSchema.nullable().default(null),
});

export type ChatThreadMessage = z.infer<typeof chatThreadMessageSchema>;

/** The chat user acting in the dashboard — the operator's own web identity. */
export const chatUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type ChatUser = z.infer<typeof chatUserSchema>;

export const chatUserResponseSchema = z.object({ user: chatUserSchema });

/** Thread name: long enough to be a sentence, short enough to be a label. */
const threadNameSchema = z.string().trim().min(1).max(120);

/** POST /internal/threads — start a thread with one assistant. */
export const chatThreadCreateRequestSchema = z.object({
  assistantId: z.string().min(1),
  name: threadNameSchema,
});

/** PATCH /internal/threads/:id — rename (the assistant never changes). */
export const chatThreadUpdateRequestSchema = z.object({ name: threadNameSchema });

export const chatThreadsResponseSchema = z.object({ threads: z.array(chatThreadSchema) });

/** One thread on its own — the answer to creating or renaming it. */
export const chatThreadCreatedResponseSchema = z.object({ thread: chatThreadSchema });

/**
 * What the core is doing in this thread right now — the source's native
 * rendering of the turn lifecycle (PLAN.md), which in a browser is live
 * progress under the transcript rather than a typing indicator. Null when
 * no turn is running.
 */
export const chatThreadTurnSchema = z.object({
  /** Source-local id of the message being answered. */
  sourceMessageId: z.string().min(1),
  /** What the turn is doing right now (a tool's label), or null. */
  activity: z.string().nullable(),
  since: z.string().min(1),
});

export type ChatThreadTurn = z.infer<typeof chatThreadTurnSchema>;

export const chatThreadResponseSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatThreadMessageSchema),
  turn: chatThreadTurnSchema.nullable().default(null),
});

/**
 * POST /internal/threads/:id/messages — the human says something, optionally
 * with an image. The bytes arrive base64 (the browser reads the file, the
 * proxy passes it through); the chat app normalizes them to a bounded JPEG
 * before storing, so the vision pipeline gets what it gets from every source.
 *
 * Either text or an image is required: a picture with no words is a perfectly
 * good message, and so is "what is this?".
 */
export const chatPostMessageRequestSchema = z
  .object({
    text: z.string().trim().max(10_000).default(""),
    image: z
      .object({
        dataBase64: z.string().min(1),
        mimeType: z.string().max(200).nullable().optional(),
      })
      .optional(),
  })
  .refine((value) => value.text.length > 0 || value.image !== undefined, {
    message: "a message needs text, an image, or both",
  });

/**
 * What posting answers with: the stored message and the correlation id of the
 * turn it started, so the caller can follow that turn's progress.
 */
export const chatPostMessageResponseSchema = z.object({
  message: chatThreadMessageSchema,
  /** Null when the message was stored but no turn was enqueued. */
  correlationId: z.string().nullable(),
});
