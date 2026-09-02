import { z } from "zod";

import { scopedRefSchema, sourceIdSchema } from "./scoped-ref";

export { sourceIdSchema };

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
  /**
   * Which assistant authored an `assistant` row. Chats where several
   * assistants speak need it to render each other's lines as somebody
   * else's words rather than the reader's own. Null/absent means the source
   * does not know (pre-Phase-3 rows), which reads as the reader's own.
   */
  assistantId: z.string().nullable().optional(),
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
  /** Source-specific chat subtype (`group` / `supergroup`), or null. */
  type: z.string().nullable().optional(),
  /** Operator-curated notes about the chat, or null. */
  notes: z.string().nullable().optional(),
  /** Operator-configured reply language for this chat, or null (default). */
  language: z.string().nullable().optional(),
  /**
   * True when `title` is a placeholder the source invented (a web thread
   * starts as "New chat") and it would like the conversation named from what
   * is actually said in it. The core names it once, after the first exchange,
   * through the source's own `setChatTitle` — a source that has real names
   * for its conversations, as Telegram does, never sets this.
   */
  titleProvisional: z.boolean().optional(),
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
  /** Raw profile name parts (the label is composed from these). */
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
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
  /**
   * True when the quoted message carries readable media — the core resolves
   * it to text through the source's internal media API ("what is this?" as a
   * reply to an earlier image).
   */
  hasMedia: z.boolean().default(false),
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
 *
 * Optional on an inbound event: a source whose conversations have no account
 * of their own (a web thread — the assistant IS the thread's binding) omits
 * it, and the core falls back to the assistant's own identity, which it
 * already prefers where the two disagree.
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
  connection: connectionIdentitySchema.optional(),
  chat: chatInfoSchema,
  sender: senderInfoSchema,
  /**
   * Set when the message was authored by ANOTHER assistant and cross-fed by
   * the source: Telegram never delivers a bot's messages to other bots, so
   * without this the assistants sharing a group can never hear each other
   * (PLAN "Shared-chat behavior"). `sender` then describes the authoring
   * bot's ACCOUNT — the core resolves the speaking assistant's own name
   * from this id — and the core's loop guard counts these turns.
   */
  authoredByAssistantId: z.string().min(1).nullable().optional(),
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
   * Deliver without a notification ping — a reply that is only a transient
   * acknowledgement of background work (a browsing run) that will report
   * for itself. The source renders it however "silent" looks there.
   *
   * Voice replies do NOT travel this event: their audio bytes are produced
   * by the core (TTS is a core feature) and cross the owning source's
   * internal API, which can answer with the delivered id (slice D).
   */
  silent: z.boolean().default(false),
  /**
   * The mirror-checked whitelist for `#<id>` citation links in `text`,
   * resolved by the core (it owns the mirror since Phase 7): ids the
   * transport may render as tappable message links; anything else stays
   * plain text. Absent → no links.
   */
  linkableSourceMessageIds: z.array(z.string().min(1)).optional(),
});

/**
 * Turn progress, published by the core for every inbound message and
 * rendered natively by the owning source (typing indicator / thread
 * progress). Never an MCP tool (PLAN).
 */
export const turnLifecycleEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("turn.lifecycle"),
  source: sourceIdSchema,
  /**
   * The assistant running the turn — sources that keep per-assistant DM
   * streams scope the settle's hold release with it. Optional: older
   * publishers omitted it.
   */
  assistantId: z.string().min(1).optional(),
  chatRef: scopedRefSchema,
  /** Source-local id of the inbound message the turn belongs to. */
  sourceMessageId: z.string().min(1),
  /** Source-local sub-thread the turn lives in (typing renders there), or null. */
  threadId: z.string().nullable().optional(),
  phase: z.enum(["accepted", "progress", "settled"]),
  /** Short human label of current activity (tool name), for `progress`. */
  activity: z.string().nullable().optional(),
});

/**
 * One piece of user feedback on an assistant reply, completed through the
 * owning source's collection flow (tg: 👍/👎 reaction → options menu →
 * answer). The raw rows live in the source's store (user decision,
 * 2026-08-22 — conversation-derived content); this event is how the core's
 * learning jobs (reflection, preference/correction folding, addressing
 * exclusions) hear about a completed one without polling the source.
 */
export const feedbackRecordedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("feedback.recorded"),
  source: sourceIdSchema,
  feedback: z.object({
    /** The source-store feedback row id (write-backs address it). */
    id: z.string().min(1),
    chatRef: scopedRefSchema,
    /** Source-local id of the reacted assistant reply. */
    sourceMessageId: z.string().min(1),
    /** Scoped ref of the person who gave the feedback. */
    userRef: scopedRefSchema,
    reaction: z.enum(["up", "down"]),
    /** The chosen option text or the user's own words. */
    text: z.string().min(1),
    /** `quality` feeds reflection/folding; `addressing` files an exclusion. */
    topic: z.enum(["quality", "addressing"]),
  }),
});

/**
 * A live-refresh ping for the dashboard: something changed in a source
 * app's store (a mirrored message, a poller status flip, an opened
 * feedback menu) and the pages watching the named SSE topics should
 * re-read. The core bridges these onto its in-process `publishEvent` —
 * the `publishEvent`/`useLiveRefresh` contract survives the split, its
 * backbone changes (PLAN "Events").
 */
export const dashboardRefreshEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("dashboard.refresh"),
  source: sourceIdSchema,
  /** The SSE topics to ping (the core's `RealtimeTopic` names). */
  topics: z.array(z.string().min(1)).min(1).max(16),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type DashboardRefreshEvent = z.infer<typeof dashboardRefreshEventSchema>;
export type FeedbackRecordedEvent = z.infer<typeof feedbackRecordedEventSchema>;
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
/**
 * `assistant.deleted` — the core removed an assistant (PLAN "Entity
 * lifecycle across apps"): every source app drops what it keys on that
 * assistant id (tg stops the poller and deletes the connection row).
 * Published by the core, so it carries no source id.
 */
export const assistantDeletedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("assistant.deleted"),
  assistantId: z.string().min(1),
});

export type AssistantDeletedEvent = z.infer<typeof assistantDeletedEventSchema>;

export type ReplyDeliveryEvent = z.infer<typeof replyDeliveryEventSchema>;
export type TurnLifecycleEvent = z.infer<typeof turnLifecycleEventSchema>;

/**
 * The id every event, job and trace of ONE turn shares (PLAN "Traces").
 *
 * A turn is one assistant acting on one message — not one message. Several
 * assistants can share a chat, and each is handed its own turn for the same
 * message, so the receiving assistant is part of the id. Without it their
 * turn-action markers and traces would collide: one turn's settle would clear
 * the other's marker, and Debug would show two turns as one.
 *
 * (Source-local ids: a Telegram DM's chat id is the peer's user id and its
 * message ids are numbered per bot, so the chat/message pair alone is not even
 * unique across bots there.)
 */
export function turnCorrelationId(
  chatId: string,
  sourceMessageId: string,
  assistantId: string,
): string {
  return `${chatId}:${sourceMessageId}:${assistantId}`;
}

/**
 * The stream-identity key a stored message deduplicates on (redesign
 * Phase 7): the owning transport computes it, the core's conversation store
 * enforces uniqueness on `(source, dedupe_key)` and never has to know a
 * platform's stream rules. Pass `assistantId` when the message belongs to
 * ONE assistant's stream (telegram DM rows — message ids are per bot there);
 * omit it for a shared stream (a telegram group, which every poller mirrors
 * idempotently).
 */
export function messageDedupeKey(input: {
  chatId: string;
  sourceMessageId: string;
  assistantId?: string | null;
}): string {
  return input.assistantId
    ? `${input.chatId}:${input.assistantId}:${input.sourceMessageId}`
    : `${input.chatId}:${input.sourceMessageId}`;
}

/** The queue the core pipeline consumes: one job per inbound message. */
export const INBOUND_MESSAGES_QUEUE = "inbound-messages";

/**
 * The pub/sub channel cross-app events travel on (reply deliveries, turn
 * lifecycle, status/progress the core bridges to SSE). One channel; the
 * `type` field discriminates — consumers filter, Redis fans out.
 */
export const BUS_EVENTS_CHANNEL = "assistant-hub:events";
