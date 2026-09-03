/**
 * `@assistant-hub-swarm/transport-sdk` — everything a **transport** needs to
 * connect a messaging platform to an assistant-hub core, and nothing else.
 *
 * A transport is a stateless service that owns exactly one platform: it
 * registers with a running core, forwards every update it sees as normalized
 * events, performs the sends the core asks for, and hosts its platform's own
 * actions as MCP tools. It has no database and no files. The whole contract is
 * re-exported here — see
 * [Adding a transport](https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/development/adding-a-transport.md)
 * for the manual that walks it in the order you meet it.
 *
 * The surface is deliberately narrower than the core's own contracts package:
 * the shapes below are the **wire**, and they are what this package's semver
 * covers. The core's dashboard DTOs, its operator listings and its content
 * plane are not here — a transport never speaks them, and they change with the
 * dashboard.
 *
 * Two versions matter, and they are not the same number:
 *
 * - This package's **semver** covers the TypeScript API below.
 * - {@link CONTRACT_MAJOR} is the **wire** major. Announce it at registration;
 *   a core that speaks another major refuses you by name, with a reason its
 *   dashboard shows. Bump the SDK and rebuild when that happens.
 */

// ---- Identity: how anything points at anything ----------------------------
export {
  REF_KINDS,
  SOURCE_ID_PATTERN,
  WEB_CHAT_SOURCE,
  formatScopedRef,
  isScopedRef,
  isSourceId,
  parseScopedRef,
  scopedRef,
  scopedRefSchema,
  tryParseScopedRef,
  type RefKind,
  type ScopedRef,
  type ScopedRefString,
  type SourceId,
} from "@assistant-hub-swarm/contracts";

// ---- The wire's major version ---------------------------------------------
export { CONTRACT_MAJOR } from "@assistant-hub-swarm/contracts";

// ---- Registration, desired state, and the updates you publish -------------
export {
  TRANSPORT_UPDATES_QUEUE,
  messageDeliveredEventSchema,
  transportBotReactionEventSchema,
  transportCallbackRequestSchema,
  transportCallbackResponseSchema,
  transportChatSchema,
  transportConfigChangedEventSchema,
  transportConfigFieldSchema,
  transportDesiredConnectionSchema,
  transportDesiredStateSchema,
  transportEditEventSchema,
  transportMediaSchema,
  transportMessageEventSchema,
  transportMessageLookupResponseSchema,
  transportPresenceEventSchema,
  transportReactionEventSchema,
  transportReceiverSchema,
  transportRegistrationRequestSchema,
  transportReplyContextSchema,
  transportUpdateEventSchema,
  transportUserSchema,
  type MessageDeliveredEvent,
  type TransportBotReactionEvent,
  type TransportCallbackRequest,
  type TransportCallbackResponse,
  type TransportChat,
  type TransportConfigChangedEvent,
  type TransportConfigField,
  type TransportDesiredConnection,
  type TransportDesiredState,
  type TransportEditEvent,
  type TransportMedia,
  type TransportMessageEvent,
  type TransportMessageLookupResponse,
  type TransportPresenceEvent,
  type TransportReactionEvent,
  type TransportReceiver,
  type TransportRegistrationRequest,
  type TransportReplyContext,
  type TransportUpdateEvent,
  type TransportUser,
} from "@assistant-hub-swarm/contracts";

// ---- What the core publishes back, and the ids one turn shares -------------
export {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  addressingSchema,
  assistantDeletedEventSchema,
  chatInfoSchema,
  connectionIdentitySchema,
  conversationContextSchema,
  dashboardRefreshEventSchema,
  eventEnvelopeSchema,
  feedbackRecordedEventSchema,
  historyMessageSchema,
  inboundMessageEventSchema,
  messageDedupeKey,
  messageMediaSchema,
  participantSchema,
  replyDeliveryEventSchema,
  replyTargetSchema,
  senderInfoSchema,
  sourceIdSchema,
  turnCorrelationId,
  turnLifecycleEventSchema,
  type Addressing,
  type AssistantDeletedEvent,
  type ChatInfo,
  type ConnectionIdentity,
  type ConversationContext,
  type DashboardRefreshEvent,
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
} from "@assistant-hub-swarm/contracts";

// ---- The HTTP surface the core calls on you (sends only) -------------------
export {
  internalDeleteMessageResponseSchema,
  internalEditMenuRequestSchema,
  internalSendFileRequestSchema,
  internalSendMenuRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  internalSentFileResponseSchema,
  internalSentMenuResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
  internalSetTitleRequestSchema,
  internalSetTitleResponseSchema,
  type InternalDeleteMessageResponse,
  type InternalSentFileResponse,
  type InternalSentMessageResponse,
  type InternalSentPhotosResponse,
  type InternalSentVoiceResponse,
} from "@assistant-hub-swarm/contracts";

// ---- Your MCP tools: the turn they are bound to, the delivery they report --
export {
  TOOL_DELIVERY_KEY,
  TURN_META_KEY,
  readToolDelivery,
  readTurnMeta,
  toolDeliveryResult,
  toolDeliverySchema,
  turnMetaEnvelope,
  turnToolMetaSchema,
  type ToolDelivery,
  type TurnToolMeta,
} from "@assistant-hub-swarm/contracts";

// ---- Traces: what you did, in the core's one debug explorer ----------------
export {
  createSourceTraceRecorder,
  sourceTraceEventSchema,
  sourceTraceSchema,
  traceRecordedEventSchema,
  type SourceTrace,
  type SourceTraceClient,
  type SourceTraceRecorder,
  type TraceRecordedEvent,
} from "@assistant-hub-swarm/contracts";

// ---- Redis: the update queue and the event bus -----------------------------
export {
  openPublisher,
  openQueue,
  openSubscriber,
  openWorker,
  type BusPublisher,
  type BusSubscription,
} from "@assistant-hub-swarm/bus";

// ---- Service plumbing: env, the token guard, MCP over Hono, bus helpers ----
export {
  INTERNAL_TOKEN_HEADER,
  busTraceClient,
  dashboardRefresh,
  internalTokenGuard,
  optionalEnv,
  requireEnv,
  serveMcp,
  type EventPublisher,
} from "@assistant-hub-swarm/service";

// ---- Media: the bounded JPEG the core's vision endpoints accept ------------
export {
  VISION_MAX_DIMENSION,
  normalizeImageForChat,
  type ImagePayload,
} from "@assistant-hub-swarm/media";
