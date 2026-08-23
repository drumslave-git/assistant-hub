/**
 * Cross-app contracts (PLAN.md, "The source-app contract").
 *
 * Present: scoped entity refs, the shared embedding width, and the
 * source-app event contract (inbound events with conversation context,
 * reply-delivery, turn lifecycle, queue/channel names). Landing with later
 * phases: the operator listing/CRUD API shapes the dashboard aggregates
 * (Phase 2, as tg's operator API is built), source-status events.
 */
export { DEFAULT_ASSISTANT_ID } from "./assistants";
export { EMBEDDING_DIMENSIONS } from "./embeddings";
export {
  internalDeleteMessageResponseSchema,
  internalMediaDescribeRequestSchema,
  internalMediaDescribeResponseSchema,
  internalMediaResponseSchema,
  internalMediaSchema,
  internalReactionRequestSchema,
  internalReactionResponseSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
  type InternalDeleteMessageResponse,
  type InternalMedia,
  type InternalMediaDescribeResponse,
  type InternalReactionResponse,
  type InternalSentMessageResponse,
  type InternalSentPhotosResponse,
  type InternalSentVoiceResponse,
} from "./internal-api";
export {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  addressingSchema,
  chatInfoSchema,
  connectionIdentitySchema,
  conversationContextSchema,
  eventEnvelopeSchema,
  feedbackRecordedEventSchema,
  historyMessageSchema,
  inboundMessageEventSchema,
  messageMediaSchema,
  participantSchema,
  replyDeliveryEventSchema,
  replyTargetSchema,
  senderInfoSchema,
  sourceIdSchema,
  turnLifecycleEventSchema,
  type Addressing,
  type ChatInfo,
  type ConnectionIdentity,
  type ConversationContext,
  type EventEnvelope,
  type FeedbackRecordedEvent,
  type HistoryMessage,
  type InboundMessageEvent,
  type MessageMedia,
  type Participant,
  type ReplyDeliveryEvent,
  type ReplyTarget,
  type SenderInfo,
  type TurnLifecycleEvent,
} from "./source-events";
export {
  REF_KINDS,
  SOURCE_IDS,
  formatScopedRef,
  isScopedRef,
  parseScopedRef,
  scopedRef,
  scopedRefSchema,
  tryParseScopedRef,
  type RefKind,
  type ScopedRef,
  type ScopedRefString,
  type SourceId,
} from "./scoped-ref";
