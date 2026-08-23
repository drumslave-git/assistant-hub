import { z } from "zod";

import { SOURCE_IDS, scopedRefSchema } from "./scoped-ref";

/**
 * The source-app contract's event shapes (PLAN.md, "The source-app contract"
 * and "Message flow"), shaped by what the v1 pipeline actually consumes
 * (`BotMessagingDeps` — see the Phase 2 boundary study in PROGRESS.md):
 *
 * - **Inbound**: the source persists the message in its own store, then
 *   enqueues ONE normalized {@link inboundMessageEventSchema} carrying the
 *   conversation context (history window + participants + chat metadata) —
 *   the core never reads a source's store.
 * - **Outbound, deterministic**: the core publishes a
 *   {@link replyDeliveryEventSchema}; the owning source persists the reply
 *   in its store and performs the send.
 * - **Turn lifecycle**: the core publishes {@link turnLifecycleEventSchema}
 *   (accepted / progress / settled); the owning source renders it natively
 *   (Telegram typing indicator, web thread progress).
 *
 * Versioned via `v` so shapes can evolve during the split without silent
 * drift; every event carries the `correlationId` that ties a turn's
 * cross-app flow into one trace.
 */

export const sourceIdSchema = z.enum(SOURCE_IDS);

/** Fields every cross-app event shares. */
export const eventEnvelopeSchema = z.object({
  v: z.literal(1),
  /** Unique id of this event instance. */
  eventId: z.string().min(1),
  /** ISO instant the event was created. */
  occurredAt: z.string().min(1),
  /** Ties every event/job of one turn into one trace (PLAN "Traces"). */
  correlationId: z.string().min(1),
});

/** Media on a message, resolved to TEXT by the owning source (vision pipeline). */
export const messageMediaSchema = z.object({
  /** The owning source's media row id. */
  id: z.string().min(1),
  /** Source-side media kind (`photo`, `sticker`, `video`, `image`, `voice`, …). */
  kind: z.string().min(1),
  /** The description/transcript, or null while still pending. */
  description: z.string().nullable(),
  status: z.enum(["pending", "described", "unavailable"]),
});

/** One line of the source-composed history window. */
export const historyMessageSchema = z.object({
  /** Source-local message id (`#<id>` transcript anchors dereference it). */
  sourceMessageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  /** Scoped ref of the human sender; null for assistant rows. */
  senderRef: scopedRefSchema.nullable(),
  /** Display label the source resolved for the sender (names + username). */
  senderLabel: z.string().nullable(),
  content: z.string(),
  sentAt: z.string().min(1),
  /** Source-local id of the message this one replied to, or null. */
  replyToSourceMessageId: z.string().nullable().optional(),
  /** The assistant's current reaction badge on this message, or null. */
  botReaction: z.string().nullable().optional(),
  /** Rendered media annotation for this line, or null (no media). */
  mediaNote: z.string().nullable().optional(),
});

/** One known participant of the conversation, as the source knows them. */
export const participantSchema = z.object({
  ref: scopedRefSchema,
  /** Display label (names + username), resolved by the source. */
  label: z.string().min(1),
  username: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
});

/**
 * The conversation context the source supplies with an inbound event — the
 * composed history window and participant roster (the contract's "context
 * provider" duty). The core composes prompts from this; it never queries
 * the source's database.
 */
export const conversationContextSchema = z.object({
  history: z.array(historyMessageSchema),
  participants: z.array(participantSchema),
});

/** The chat an inbound message arrived in, as the source knows it. */
export const chatInfoSchema = z.object({
  ref: scopedRefSchema,
  /** `direct` (one human) or `group` (roster + addressing rules apply). */
  kind: z.enum(["direct", "group"]),
  title: z.string().nullable().optional(),
  /** Operator-curated notes about the chat, or null. */
  notes: z.string().nullable().optional(),
  /** Operator-configured reply language for this chat, or null (default). */
  language: z.string().nullable().optional(),
});

/** The sender of an inbound message, as the source knows them. */
export const senderInfoSchema = z.object({
  ref: scopedRefSchema,
  /**
   * Owner check, RESOLVED by the source app (user decision, 2026-08-22:
   * owner logic and settings live on the app side; the core only ever
   * receives this flag).
   */
  isOwner: z.boolean(),
  /** Display label (names + username), resolved by the source. */
  label: z.string().min(1),
  username: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
  /** Operator-configured reply language for this person's direct chat. */
  language: z.string().nullable().optional(),
});

/** The reply target of the inbound message, when it quoted another message. */
export const replyTargetSchema = z.object({
  sourceMessageId: z.string().min(1),
  /**
   * True when the target is in the source's mirror — the core then renders
   * it as a dereferenceable `#<id>` anchor; false inlines sender + text.
   */
  stored: z.boolean().default(false),
  /** Sender label of the quoted message, resolved by the source. */
  senderLabel: z.string().nullable(),
  /** True when the quoted message is the assistant's own (label is then the core's call). */
  fromAssistant: z.boolean().default(false),
  /** The quoted message's text/caption, or null when it had none. */
  text: z.string().nullable(),
  /** Partial-quote fragment, when the user quoted a specific part. */
  quote: z.string().nullable().optional(),
});

/**
 * The receiving connection's identity — what people call the assistant in this
 * source. The core's addressing analyzer and its bot label in transcripts
 * need it; the source knows it (it owns the connection).
 */
export const connectionIdentitySchema = z.object({
  /** The bot's @username in the source (no leading `@`). */
  botUsername: z.string().min(1),
  /** The bot's display name — what people call it in a group. */
  botDisplayName: z.string().min(1),
});

/**
 * The DETERMINISTIC addressing verdict, computed by the source — it reads
 * the source's wire format (Telegram entities, mentions, commands, reply
 * targets), which never crosses the contract. `needsAnalyzer` hands the
 * genuinely ambiguous case (the name in another alphabet or an inflected
 * form) to the core's LLM analyzer; the core never re-runs the
 * deterministic half.
 */
export const addressingSchema = z.object({
  addressed: z.boolean(),
  /** What decided it, when something did. */
  source: z.enum(["private", "mention", "reply", "command", "name"]).nullable().optional(),
  /** True when only the core's LLM analyzer can settle it. */
  needsAnalyzer: z.boolean().default(false),
  /** Human explanation of the verdict, when there is one to give. */
  reason: z.string().nullable().optional(),
});

/**
 * One normalized inbound message — the queue job the core pipeline consumes
 * (one BullMQ job per inbound message, `attempts: 1`; the turn runner alone
 * decides re-enqueue via the actions-started marker).
 */
export const inboundMessageEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("message.inbound"),
  source: sourceIdSchema,
  /** The assistant implied by the receiving connection (bot) or thread. */
  assistantId: z.string().min(1),
  connection: connectionIdentitySchema,
  chat: chatInfoSchema,
  sender: senderInfoSchema,
  addressing: addressingSchema,
  message: z.object({
    sourceMessageId: z.string().min(1),
    content: z.string(),
    sentAt: z.string().min(1),
    /** Source-local sub-thread (telegram forum topic), or null. */
    threadId: z.string().nullable().optional(),
    replyTo: replyTargetSchema.nullable().optional(),
    /** Media on this message (and none elsewhere — history carries notes). */
    media: z.array(messageMediaSchema).default([]),
  }),
  context: conversationContextSchema,
});

/**
 * A finished reply for the owning source to persist in its store and send.
 * The model never has to remember to deliver its own answer.
 */
export const replyDeliveryEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("reply.delivery"),
  source: sourceIdSchema,
  assistantId: z.string().min(1),
  chatRef: scopedRefSchema,
  /** Source-local sub-thread to deliver into, or null (chat root). */
  threadId: z.string().nullable().optional(),
  /** Source-local id of the message being answered, or null (unprompted). */
  replyToSourceMessageId: z.string().nullable().optional(),
  text: z.string().min(1),
  /**
   * Deliver as a voice bubble when the source can (voice turn + configured
   * TTS); the source falls back to text and reports what it actually sent.
   */
  preferVoice: z.boolean().default(false),
});

/**
 * Turn progress, published by the core for every inbound message and
 * rendered natively by the owning source (typing indicator / thread
 * progress). Never an MCP tool (PLAN).
 */
export const turnLifecycleEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("turn.lifecycle"),
  source: sourceIdSchema,
  chatRef: scopedRefSchema,
  /** Source-local id of the inbound message the turn belongs to. */
  sourceMessageId: z.string().min(1),
  /** Source-local sub-thread the turn lives in (typing renders there), or null. */
  threadId: z.string().nullable().optional(),
  phase: z.enum(["accepted", "progress", "settled"]),
  /** Short human label of current activity (tool name), for `progress`. */
  activity: z.string().nullable().optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;
export type Addressing = z.infer<typeof addressingSchema>;
export type MessageMedia = z.infer<typeof messageMediaSchema>;
export type HistoryMessage = z.infer<typeof historyMessageSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ConversationContext = z.infer<typeof conversationContextSchema>;
export type ChatInfo = z.infer<typeof chatInfoSchema>;
export type SenderInfo = z.infer<typeof senderInfoSchema>;
export type ReplyTarget = z.infer<typeof replyTargetSchema>;
export type InboundMessageEvent = z.infer<typeof inboundMessageEventSchema>;
export type ReplyDeliveryEvent = z.infer<typeof replyDeliveryEventSchema>;
export type TurnLifecycleEvent = z.infer<typeof turnLifecycleEventSchema>;

/** The queue the core pipeline consumes: one job per inbound message. */
export const INBOUND_MESSAGES_QUEUE = "inbound-messages";

/**
 * The pub/sub channel cross-app events travel on (reply deliveries, turn
 * lifecycle, status/progress the core bridges to SSE). One channel; the
 * `type` field discriminates — consumers filter, Redis fans out.
 */
export const BUS_EVENTS_CHANNEL = "assistant-hub:events";
