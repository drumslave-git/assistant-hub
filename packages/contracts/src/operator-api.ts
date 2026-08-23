import { z } from "zod";

/**
 * The shared operator listing/CRUD contract (PLAN.md, "The source-app
 * contract"): every source app serves these shapes for its own entities —
 * users, chats, messages, connections, its settings — and the dashboard
 * aggregates them through the core proxy. The proxy authenticates the
 * operator session; the source trusts only the internal token, so these
 * endpoints live on the same `/internal/*` surface as the media and send
 * APIs.
 *
 * Shapes are source-neutral: ids are source-local strings (the scoped-ref
 * prefix is the aggregator's business), `kind` distinguishes direct chats
 * from groups, and source-specific extras (a Telegram group's `type`) ride
 * nullable fields.
 */

/** One person the source knows, with the operator-curated fields. */
export const operatorUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /** Display label the source resolved (name + username, or a fallback). */
  label: z.string().min(1),
  /** Operator-curated alternate names/nicknames. */
  aliases: z.array(z.string()),
  /** Operator-configured reply language for this person's direct chat. */
  language: z.string().nullable(),
  firstSeenAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type OperatorUser = z.infer<typeof operatorUserSchema>;

/** GET /internal/users */
export const operatorUsersResponseSchema = z.object({
  users: z.array(operatorUserSchema),
});

/**
 * PATCH /internal/users/:id — one operator-curated field per call (the
 * dashboard saves each field on its own; v1 semantics).
 */
export const operatorUserUpdateRequestSchema = z.union([
  z.object({ aliases: z.array(z.string().min(1).max(100)).max(20) }),
  z.object({ language: z.string().max(100).nullable() }),
]);

/** GET /internal/users/:id and the PATCH response. */
export const operatorUserResponseSchema = z.object({
  user: operatorUserSchema.nullable(),
});

/**
 * One conversation the source carries, summarized for the listing: mirror
 * aggregates for every chat, metadata for the ones the source has a chat
 * row for (groups; a direct chat's identity is its user).
 */
export const operatorChatSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["direct", "group"]),
  title: z.string().nullable(),
  /** Source-specific chat subtype (`group` / `supergroup`), or null. */
  type: z.string().nullable(),
  /** Operator-curated free-text description (groups only). */
  notes: z.string().nullable(),
  /** Operator-configured reply language for this chat. */
  language: z.string().nullable(),
  /** Mirrored messages in this chat (soft-deleted rows excluded). */
  messageCount: z.number().int().nonnegative(),
  /** When the newest mirrored message was sent, or null (metadata-only row). */
  lastMessageAt: z.string().nullable(),
});

export type OperatorChat = z.infer<typeof operatorChatSchema>;

/** GET /internal/chats */
export const operatorChatsResponseSchema = z.object({
  chats: z.array(operatorChatSchema),
});

/** PATCH /internal/chats/:id — one operator-curated field per call. */
export const operatorChatUpdateRequestSchema = z.union([
  z.object({ notes: z.string().max(2000).nullable() }),
  z.object({ language: z.string().max(100).nullable() }),
]);

export const operatorChatResponseSchema = z.object({
  chat: operatorChatSchema.nullable(),
});

/** One mirrored message, as the dashboard's history detail renders it. */
export const operatorMessageSchema = z.object({
  /** Source-local message id (`#<id>` anchors, trace correlations). */
  sourceMessageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  /** Sender's source-local user id for `user` rows; null for the assistant. */
  userId: z.string().nullable(),
  content: z.string(),
  replyToSourceMessageId: z.string().nullable(),
  sentAt: z.string().min(1),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  /** The assistant's current reaction badge on this message, or null. */
  botReaction: z.string().nullable(),
  /** Media on this message (kind + describe state), or null. */
  media: z
    .object({
      kind: z.string().min(1),
      status: z.enum(["pending", "described", "unavailable"]),
      description: z.string().nullable(),
    })
    .nullable(),
});

export type OperatorMessage = z.infer<typeof operatorMessageSchema>;

/** GET /internal/chats/:id/messages — the chat's full mirror, oldest first. */
export const operatorMessagesResponseSchema = z.object({
  messages: z.array(operatorMessageSchema),
});

/**
 * One connection (a bot identity serving an assistant) — desired state from
 * the source's store joined with the actual poller state. The token never
 * leaves the source; the listing carries only its last characters so the
 * operator can tell tokens apart.
 */
export const operatorConnectionSchema = z.object({
  id: z.string().min(1),
  assistantId: z.string().min(1),
  enabled: z.boolean(),
  /** Last 4 characters of the stored token — never the token itself. */
  botTokenHint: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Actual poller state, when the runtime tracks this connection. */
  status: z
    .object({
      state: z.enum(["running", "error", "stopped"]),
      username: z.string().nullable(),
      since: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});

export type OperatorConnection = z.infer<typeof operatorConnectionSchema>;

/** GET /internal/connections (slice D shape: rows + live status). */
export const operatorConnectionsResponseSchema = z.object({
  connections: z.array(operatorConnectionSchema),
});

/** POST /internal/connections — create (and reconcile) one connection. */
export const operatorConnectionCreateRequestSchema = z.object({
  assistantId: z.string().min(1),
  botToken: z.string().min(1),
  enabled: z.boolean().default(true),
});

/** PATCH /internal/connections/:id — desired-state changes, reconciled. */
export const operatorConnectionUpdateRequestSchema = z.object({
  botToken: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export const operatorConnectionResponseSchema = z.object({
  connection: operatorConnectionSchema.nullable(),
});

/** GET/PUT /internal/settings — what is this source's to decide (owner identity). */
export const operatorSourceSettingsSchema = z.object({
  ownerUsername: z.string().nullable(),
  /** Resolved lazily on the owner's first message; read-only here. */
  ownerUserId: z.string().nullable(),
});

export type OperatorSourceSettings = z.infer<typeof operatorSourceSettingsSchema>;

export const operatorSourceSettingsResponseSchema = z.object({
  settings: operatorSourceSettingsSchema,
});

export const operatorSourceSettingsUpdateRequestSchema = z.object({
  ownerUsername: z.string().max(100).nullable(),
});
