import { z } from "zod";

import {
  addressingSchema,
  connectionIdentitySchema,
  eventEnvelopeSchema,
  sourceIdSchema,
} from "./source-events";

/**
 * The transport contract's update events (redesign Phase 7, PLAN.md "The
 * transport contract"): a stateless transport forwards EVERYTHING — every
 * message (addressed or not), every edit, every reaction, every delivery it
 * performed — as normalized events on the {@link TRANSPORT_UPDATES_QUEUE},
 * with media bytes attached. The core's ingest consumer persists them into
 * the conversation store, resolves the audience from core-owned presence,
 * composes the conversation context, and hands the existing turn-event shape
 * to the pipeline.
 *
 * What still travels the OLD `message.inbound` shape: the turn events the
 * ingest itself builds (and the web chat's, built in-process) — that shape
 * became core-internal with this contract.
 */

/** A platform user's raw profile, as the transport saw it on the wire. */
export const transportUserSchema = z.object({
  /** Source-local user id. */
  userId: z.string().min(1),
  /** Platform handle (normalized lowercase, no `@`), or null. */
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
});

/** The chat an update belongs to, as the transport saw it. */
export const transportChatSchema = z.object({
  /** Source-local chat id. */
  id: z.string().min(1),
  /** `direct` (per-assistant streams) or `group` (one shared stream). */
  kind: z.enum(["direct", "group"]),
  title: z.string().nullable().optional(),
  /** The platform's own chat type string (`group` / `supergroup`), or null. */
  type: z.string().nullable().optional(),
});

/**
 * One running connection an update may open a turn for, with the structural
 * addressing verdict the transport computed against THAT connection's bot
 * account (entities/mentions/commands/reply targets never cross the
 * contract — the verdict does).
 */
export const transportReceiverSchema = z.object({
  assistantId: z.string().min(1),
  identity: connectionIdentitySchema,
  addressing: addressingSchema,
});

/** Media on an update, downloaded and normalized by the transport. */
export const transportMediaSchema = z.object({
  /** Media kind: `photo` | `sticker` | `image_document` | `animation` | `video` | `voice`. */
  kind: z.string().min(1),
  /** Source-local file handle, kept for provenance. */
  fileId: z.string(),
  fileUniqueId: z.string().nullable(),
  mimeType: z.string().nullable(),
  /** Extra hint for the describer (a sticker's emoji, a frame-sequence note). */
  visionHint: z.string().nullable(),
  /** Ordered base64 payload — one image, sampled video frames, or raw audio. */
  frames: z.array(z.string()),
  /** True when the bytes could not be loaded — recorded, never re-attempted. */
  unavailable: z.boolean().default(false),
});

/** The reply target of an inbound message, as the transport saw it. */
export const transportReplyContextSchema = z.object({
  sourceMessageId: z.string().min(1),
  /** True when the quoted message visibly carries media. */
  hasMedia: z.boolean().default(false),
  /** The quoted message's text/caption, or null when it had none. */
  text: z.string().nullable(),
  /** Partial-quote fragment, when the user quoted a specific part. */
  quote: z.string().nullable().optional(),
  /** The quoted message's author profile, or null (e.g. a bot's own message). */
  author: transportUserSchema.nullable(),
  /**
   * The assistant whose bot authored the quoted message, when it was one of
   * this deployment's own — the transport recognizes its running bots' ids.
   */
  authorAssistantId: z.string().nullable(),
});

/** One new inbound platform message, media bytes attached. */
export const transportMessageEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.message"),
  source: sourceIdSchema,
  /** The connection (assistant) whose poller received this update. */
  receivedBy: z.string().min(1),
  chat: transportChatSchema,
  // Owner rights are the CORE's judgement since Phase 8 (accounts + identity
  // links + assistant ownership) - the transport reports who spoke, nothing
  // about what they may do.
  sender: transportUserSchema,
  message: z.object({
    sourceMessageId: z.string().min(1),
    content: z.string(),
    sentAt: z.string().min(1),
    /** Source-local sub-thread (telegram forum topic), or null. */
    threadId: z.string().nullable().optional(),
    replyTo: transportReplyContextSchema.nullable().optional(),
  }),
  media: transportMediaSchema.nullable().optional(),
  /**
   * Every running connection, each with its own structural verdict. The core
   * intersects this with its presence rows to decide who gets a turn; for a
   * direct chat the receiving connection alone is listed.
   */
  receivers: z.array(transportReceiverSchema).min(1),
  /** The stream identity the message deduplicates on (`messageDedupeKey`). */
  dedupeKey: z.string().min(1),
});

/** A platform edit rewrote a message's content. */
export const transportEditEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.edited"),
  source: sourceIdSchema,
  chat: transportChatSchema,
  /** The receiving connection — scopes the edit to its DM stream. */
  assistantId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  content: z.string().min(1),
  editedAt: z.string().min(1),
});

/**
 * A human added a feedback-worthy reaction (👍/👎, mapped by the transport)
 * on some message. The core checks its mirror for whether the target is an
 * assistant reply and runs the collection flow.
 */
export const transportReactionEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.reaction"),
  source: sourceIdSchema,
  chat: transportChatSchema,
  /** The receiving connection — its bot serves the menu, its DM stream scopes. */
  assistantId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  reaction: z.enum(["up", "down"]),
  user: transportUserSchema,
});

/**
 * The assistant's own reaction badge changed (its reaction tool ran) — the
 * core records it on the mirror row so the transcript renders it and the
 * next turn remembers reacting.
 */
export const transportBotReactionEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.bot-reaction"),
  source: sourceIdSchema,
  chat: transportChatSchema,
  assistantId: z.string().nullable(),
  sourceMessageId: z.string().min(1),
  /** The emoji now on the message, or null (reaction removed). */
  emoji: z.string().nullable(),
});

/**
 * The transport performed a send — the mirror's write signal. Published for
 * EVERY delivery path (reply-delivery events, the internal send API, the
 * transport's MCP tools), so the core's mirror and cross-feed have one seam.
 */
export const messageDeliveredEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("message.delivered"),
  source: sourceIdSchema,
  chat: transportChatSchema,
  /** The authoring assistant, or null when the caller could not say. */
  assistantId: z.string().nullable(),
  sourceMessageId: z.string().min(1),
  dedupeKey: z.string().min(1),
  /** The delivered text (a voice reply's spoken words, a file's caption). */
  content: z.string(),
  replyToSourceMessageId: z.string().nullable().optional(),
  sentAt: z.string().min(1),
  threadId: z.string().nullable().optional(),
  /** A transient acknowledgement — mirrored, never cross-fed. */
  silent: z.boolean().default(false),
  /**
   * A generated image the send delivered, bytes included — the core stores
   * it as ordinary pending media so the describer recognizes what the bot
   * drew (keyed by the file id the platform minted on send).
   */
  image: z
    .object({
      fileId: z.string(),
      fileUniqueId: z.string().nullable(),
      base64: z.string().min(1),
    })
    .nullable()
    .optional(),
  /**
   * Every connection running at delivery time, for the cross-feed: the core
   * intersects with presence and hands the message to the other assistants
   * listening. The author's own identity is in here too. `botId` is the bot
   * ACCOUNT's source-local user id — the cross-fed event's sender ref.
   */
  running: z.array(
    z.object({
      assistantId: z.string().min(1),
      botId: z.string().min(1),
      identity: connectionIdentitySchema,
    }),
  ),
});

/**
 * Presence evidence without a message to carry it: a poller received a group
 * update another poller already forwarded (the transport's in-process dedupe
 * suppressed the duplicate), which still proves THIS bot is in the chat.
 */
export const transportPresenceEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.presence"),
  source: sourceIdSchema,
  chatId: z.string().min(1),
  assistantId: z.string().min(1),
});

export const transportUpdateEventSchema = z.discriminatedUnion("type", [
  transportMessageEventSchema,
  transportEditEventSchema,
  transportReactionEventSchema,
  transportBotReactionEventSchema,
  messageDeliveredEventSchema,
  transportPresenceEventSchema,
]);

export type TransportUser = z.infer<typeof transportUserSchema>;
export type TransportChat = z.infer<typeof transportChatSchema>;
export type TransportReceiver = z.infer<typeof transportReceiverSchema>;
export type TransportMedia = z.infer<typeof transportMediaSchema>;
export type TransportReplyContext = z.infer<typeof transportReplyContextSchema>;
export type TransportMessageEvent = z.infer<typeof transportMessageEventSchema>;
export type TransportEditEvent = z.infer<typeof transportEditEventSchema>;
export type TransportReactionEvent = z.infer<typeof transportReactionEventSchema>;
export type TransportBotReactionEvent = z.infer<typeof transportBotReactionEventSchema>;
export type MessageDeliveredEvent = z.infer<typeof messageDeliveredEventSchema>;
export type TransportPresenceEvent = z.infer<typeof transportPresenceEventSchema>;
export type TransportUpdateEvent = z.infer<typeof transportUpdateEventSchema>;

/** The queue the core's ingest consumes: one job per transport update. */
export const TRANSPORT_UPDATES_QUEUE = "transport-updates";

/**
 * A feedback-menu button press, POSTed by the transport to the core's
 * internal transport API *synchronously*: the platform's button spinner
 * wants an answer (a toast) that only the flow's outcome can word.
 */
export const transportCallbackRequestSchema = z.object({
  source: sourceIdSchema,
  /** The receiving connection (its bot answers the query and edits the menu). */
  assistantId: z.string().min(1),
  chat: transportChatSchema,
  user: transportUserSchema,
  /** Source-local id of the menu message the button lives on. */
  menuSourceMessageId: z.string().min(1),
  /** The raw callback payload the button carried. */
  data: z.string().min(1),
});

export const transportCallbackResponseSchema = z.object({
  /** Toast text for the presser, or null (the menu's own edit is the answer). */
  toast: z.string().nullable(),
});

/**
 * A transport-side tool asking the core's mirror about one message (the
 * reaction tool's pre-check: does it exist, and is it the bot's own?).
 */
export const transportMessageLookupResponseSchema = z.object({
  found: z.boolean(),
  role: z.enum(["user", "assistant"]).nullable(),
  /** The assistant that authored an assistant row, when stamped. */
  assistantId: z.string().nullable(),
});

export type TransportCallbackRequest = z.infer<typeof transportCallbackRequestSchema>;
export type TransportCallbackResponse = z.infer<typeof transportCallbackResponseSchema>;
export type TransportMessageLookupResponse = z.infer<typeof transportMessageLookupResponseSchema>;

/**
 * One field a transport's config form renders — the schema-driven UI unit
 * (PLAN.md "Dashboard"): the dashboard renders a transport's connection and
 * settings sections from these descriptors, so a new transport needs no UI
 * code in the core.
 */
export const transportConfigFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** What control the dashboard renders. Secrets are write-only. */
  kind: z.enum(["text", "secret", "boolean"]),
  /** Help line under the field, or absent. */
  help: z.string().optional(),
  required: z.boolean().optional(),
});

/**
 * POST /api/internal/transports/register — a transport announces itself at
 * boot (PLAN.md "The transport contract"): its id, name, base URL, MCP path
 * and config schemas. The core upserts the registration (preserving the
 * admin's enabled flag and the stored config blobs) and answers with the
 * transport's desired state, so registration doubles as the boot-time fetch.
 */
export const transportRegistrationRequestSchema = z.object({
  id: sourceIdSchema,
  name: z.string().min(1),
  /** The transport's internal API base URL, reachable from the core. */
  baseUrl: z.string().min(1),
  /** Path of the transport's MCP server on that base, or null. */
  mcpPath: z.string().nullable(),
  connectionConfigSchema: z.array(transportConfigFieldSchema),
  transportConfigSchema: z.array(transportConfigFieldSchema),
});

/** One desired connection: run this assistant on this opaque config. */
export const transportDesiredConnectionSchema = z.object({
  id: z.string().min(1),
  assistantId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});

/** The transport's desired state, served on registration and on refetch. */
export const transportDesiredStateSchema = z.object({
  transport: z.object({
    enabled: z.boolean(),
    /** The transport-level opaque config blob (telegram: the owner identity). */
    config: z.record(z.string(), z.unknown()),
  }),
  connections: z.array(transportDesiredConnectionSchema),
});

/**
 * `transport.config.changed` — the core changed a transport's desired state
 * (a connection edit, a settings write, an assistant deletion's cascade).
 * The transport refetches its desired state and reconciles.
 */
export const transportConfigChangedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transport.config.changed"),
  transport: sourceIdSchema,
});

export type TransportConfigField = z.infer<typeof transportConfigFieldSchema>;
export type TransportRegistrationRequest = z.infer<typeof transportRegistrationRequestSchema>;
export type TransportDesiredConnection = z.infer<typeof transportDesiredConnectionSchema>;
export type TransportDesiredState = z.infer<typeof transportDesiredStateSchema>;
export type TransportConfigChangedEvent = z.infer<typeof transportConfigChangedEventSchema>;
