import "server-only";

import { randomUUID } from "node:crypto";

import { openPublisher, openQueue, openWorker, type BusPublisher } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  inboundMessageEventSchema,
  parseScopedRef,
  type InboundMessageEvent,
  type ReplyDeliveryEvent,
  type TurnLifecycleEvent,
} from "@assistant-hub/contracts";
import type { Queue, Worker } from "bullmq";

import {
  handleIncomingMessage,
  type BotMessagingDeps,
  type HandleOutcome,
} from "@/features/bot-messaging/server/service";
import type { AddressResult, AddressSource } from "@/features/bot-messaging/server/addressing";
import {
  createTurnBindings,
  runTurnClassifier,
} from "@/features/bot-messaging/server/turn-bindings";
import { listAddressingExclusionTerms } from "@/features/bot-messaging/server/exclusions-repository";
import { buildTimeContext } from "@/features/bot-messaging/server/prompt";
import { getMemoryContext } from "@/features/memory/server/service";
import { getPreferencesContext, getLatestSelfCorrectionPrompt } from "@/features/self-improvement/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { buildStandingTasksBlock } from "@/features/tasks/format";
import { getActiveTasksForChat } from "@/features/tasks/server/service";
import { getBotPolicy, getTimezone } from "@/features/settings/server/service";
import { resolveRequiredLanguage } from "@/lib/language";
import {
  HONESTY_GATE_MAX_TOKENS,
  HONESTY_GATE_TIMEOUT_MS,
} from "@/server/llm/classifier";
import { getEnv } from "@/server/env";

import { createTurnActionMarkers, closeTurnActionStore, type TurnActionMarkers } from "./actions";
import { botTranscriptLabel, renderChatContext, renderCurrentTurn, renderHistoryWindow } from "./render";

/**
 * The queue side of the source split (redesign Phase 2): consume normalized
 * inbound events and run the SAME reply pipeline the in-process telegram
 * runtime drives — `handleIncomingMessage` with collaborators built from the
 * event instead of the database, deliveries published as bus events instead
 * of sent directly, and turn lifecycle published for the owning source to
 * render (typing) and to release its mirror hold on settle.
 *
 * Additive during the transition: everything brain-shaped (memory,
 * preferences, persona, tasks, settings/policy) still reads the v1 database,
 * so behavior matches the v1 path exactly; `event.sender.isOwner` becomes
 * authoritative at the swap (see PROGRESS.md — task-authority rights are the
 * flagged swap blocker).
 *
 * Interim gaps until slices B/D (consumer-path only, which no live traffic
 * takes yet): no vision/voice, generated images are not delivered, browser
 * runs get no self-deleting acknowledgement, and `#id` citations are not
 * resolved into links (replies deliver as plain text).
 */

/** Re-enqueue delay for a turn that failed before performing any action. */
const RETRY_DELAY_MS = 15_000;
/** Total tries for such a turn (first + re-enqueues) before it fails for good. */
const MAX_ATTEMPTS = 5;

export interface TurnConsumerContext {
  publish: (payload: ReplyDeliveryEvent | TurnLifecycleEvent) => Promise<void>;
  markers: TurnActionMarkers;
  /** Re-enqueue a pre-action failure; absent → no retry (tests, drain mode). */
  reEnqueue?: (event: InboundMessageEvent, attempt: number) => Promise<void>;
  overrides?: {
    generateReply?: BotMessagingDeps["generateReply"];
    analyzeAddressing?: BotMessagingDeps["analyzeAddressing"];
  };
  now?: () => Date;
}

function lifecycleEvent(
  event: InboundMessageEvent,
  phase: TurnLifecycleEvent["phase"],
  activity?: string,
): TurnLifecycleEvent {
  return {
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: event.correlationId,
    type: "turn.lifecycle",
    source: event.source,
    chatRef: event.chat.ref,
    sourceMessageId: event.message.sourceMessageId,
    threadId: event.message.threadId ?? null,
    phase,
    ...(activity ? { activity } : {}),
  };
}

/** Build the service collaborators from the event + the (v1) brain services. */
async function buildEventDeps(
  event: InboundMessageEvent,
  ctx: TurnConsumerContext,
): Promise<BotMessagingDeps> {
  const chatId = parseScopedRef(event.chat.ref).id;
  const senderId = parseScopedRef(event.sender.ref).id;
  const threadId = event.message.threadId != null ? Number(event.message.threadId) : null;
  const isGroup = event.chat.kind === "group";
  const botLabel = botTranscriptLabel(event.connection.botUsername);

  const [policy, personalityPrompt, selfCorrection, taskSets, timezone] = await Promise.all([
    getBotPolicy(),
    getActivePersonalityPrompt(),
    getLatestSelfCorrectionPrompt().catch(() => null),
    getActiveTasksForChat(chatId, senderId).catch(() => ({ prompt: [], message: [] })),
    getTimezone().catch(() => "UTC"),
  ]);

  const markActed = () => ctx.markers.mark(event.correlationId);

  const deliveryEvent = (text: string): ReplyDeliveryEvent => ({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: event.correlationId,
    type: "reply.delivery",
    source: event.source,
    assistantId: event.assistantId,
    chatRef: event.chat.ref,
    threadId: event.message.threadId ?? null,
    replyToSourceMessageId: event.message.sourceMessageId,
    text,
    preferVoice: false,
  });

  const bindings = createTurnBindings({
    chatId,
    senderId,
    threadId,
    correlationId: event.correlationId,
    messageText: event.message.content,
    chatType: isGroup ? "supergroup" : "private",
    policy,
    tasks: taskSets,
    // Interim gap (slice D): images generated mid-turn have no delivery
    // path on this route yet — the sink exists so the tool does not crash.
    collectImage: () => {},
    onBrowserRunEnqueued: () => {},
    deliverTaskReply: async (text: string) => {
      await markActed();
      await ctx.publish(deliveryEvent(text));
      return { messageId: null };
    },
    onBeforeToolCall: markActed,
    overrideGenerateReply: ctx.overrides?.generateReply,
  });

  return {
    // The numeric bot id only feeds the deterministic addressing check,
    // which the source already ran — 0 is deliberately inert here.
    bot: {
      id: 0,
      username: event.connection.botUsername,
      displayName: event.connection.botDisplayName,
    },
    policy,
    personalityPrompt,
    selfCorrection,
    standingTasks: buildStandingTasksBlock(taskSets.prompt),
    timeContext: buildTimeContext(ctx.now?.() ?? new Date(), timezone),
    requiredLanguage: resolveRequiredLanguage(event.chat.language ?? null),
    // Typing renders source-side from the lifecycle events: `accepted` when
    // the turn is going to be answered, `settled` when it ends (published by
    // the job wrapper on every terminal path, ignored turns included).
    startTyping: () => {
      void ctx.publish(lifecycleEvent(event, "accepted")).catch(() => undefined);
      return () => {};
    },
    loadHistory: async (options) =>
      renderHistoryWindow(event.context.history, botLabel, options),
    loadCurrentTurn: async () => renderCurrentTurn(event),
    loadChatContext: () => Promise.resolve(renderChatContext(event)),
    loadMemory: () => getMemoryContext({ chatId, senderId, isGroup }).catch(() => null),
    loadSenderPreferences: () => getPreferencesContext(senderId).catch(() => null),
    loadAddressExclusions: () => listAddressingExclusionTerms().catch(() => []),
    generateReply: bindings.generateReply,
    applyStandingTasks: bindings.applyStandingTasks,
    analyzeAddressing:
      ctx.overrides?.analyzeAddressing ??
      ((messages, callTrace) => runTurnClassifier(messages, undefined, callTrace)),
    checkActionClaim: (messages, callTrace) =>
      runTurnClassifier(
        messages,
        { maxTokens: HONESTY_GATE_MAX_TOKENS, timeoutMs: HONESTY_GATE_TIMEOUT_MS },
        callTrace,
      ),
    async sendReply(text: string) {
      // The send is an action the moment it is on the bus — mark first.
      await markActed();
      await ctx.publish(deliveryEvent(text));
      // The owning source performs the send and mirrors the delivered id;
      // this path cannot know it (see SentMessage.messageId).
      return { messageId: null };
    },
    // The owning source mirrors what it delivers — nothing to record here.
    recordReply: async () => {},
  };
}

/** Map the event's pre-decided verdict onto the service's shape. */
function toAddressResult(event: InboundMessageEvent): AddressResult {
  return {
    addressed: event.addressing.addressed,
    source: (event.addressing.source ?? undefined) as AddressSource | undefined,
    needsAnalyzer: event.addressing.needsAnalyzer,
    reason: event.addressing.reason ?? undefined,
  };
}

/** Run one inbound turn end to end (no retry policy — see handleInboundJob). */
export async function processInboundEvent(
  event: InboundMessageEvent,
  ctx: TurnConsumerContext,
): Promise<HandleOutcome> {
  const deps = await buildEventDeps(event, ctx);
  return handleIncomingMessage(
    {
      addressing: toAddressResult(event),
      chatId: Number(parseScopedRef(event.chat.ref).id),
      chatType: event.chat.kind === "group" ? "supergroup" : "private",
      messageId: Number(event.message.sourceMessageId),
      fromId: Number(parseScopedRef(event.sender.ref).id),
      fromIsBot: false,
      text: event.message.content,
      hasVision: event.message.media.length > 0,
      isVoice: false,
    },
    deps,
  );
}

export type InboundJobResult =
  | { status: "handled"; outcome: HandleOutcome }
  | { status: "retried"; attempt: number };

/**
 * The full job policy around one event: run the turn; on success publish
 * `settled` and clear the marker. On failure, re-enqueue ONLY when the turn
 * performed no action yet (the marker's whole purpose) and tries remain —
 * the turn is then still live (no `settled`, the source keeps its hold).
 * A post-action or out-of-tries failure settles the turn and rethrows so
 * the job lands in the failed set for the operator.
 *
 * Note the division of labour with the service: `handleIncomingMessage`
 * catches its own turn errors, delivers the error notice (an action) and
 * returns an `error` outcome — such turns are handled, never retried. The
 * retry path exists for failures AROUND the service — collaborator
 * building, infrastructure — which throw before any action ran.
 * `runTurn` is injectable for exactly that seam's tests.
 */
export async function handleInboundJob(
  event: InboundMessageEvent,
  attempt: number,
  ctx: TurnConsumerContext,
  runTurn: (event: InboundMessageEvent, ctx: TurnConsumerContext) => Promise<HandleOutcome> = processInboundEvent,
): Promise<InboundJobResult> {
  try {
    const outcome = await runTurn(event, ctx);
    await ctx.publish(lifecycleEvent(event, "settled"));
    await ctx.markers.clear(event.correlationId).catch(() => undefined);
    return { status: "handled", outcome };
  } catch (err) {
    const acted = await ctx.markers.has(event.correlationId).catch(() => true);
    if (!acted && attempt < MAX_ATTEMPTS && ctx.reEnqueue) {
      await ctx.reEnqueue(event, attempt + 1);
      return { status: "retried", attempt: attempt + 1 };
    }
    await ctx.publish(lifecycleEvent(event, "settled")).catch(() => undefined);
    await ctx.markers.clear(event.correlationId).catch(() => undefined);
    throw err;
  }
}

/** Attempt number encoded in a re-enqueued job's id; producer jobs are attempt 1. */
function attemptOf(jobId: string | undefined): number {
  const match = jobId?.match(/:retry:(\d+)$/);
  return match ? Number(match[1]) : 1;
}

export interface TurnConsumer {
  close(): Promise<void>;
}

/**
 * Start the inbound-turn consumer. Concurrent across chats, strictly ordered
 * within one (the v1 `sequentialize` guarantee, kept with an in-process
 * per-chat promise chain — jobs are picked FIFO, so chaining preserves
 * arrival order).
 */
export async function startTurnConsumer(input: {
  redisUrl: string;
  concurrency?: number;
}): Promise<TurnConsumer> {
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const queue: Queue<InboundMessageEvent> = openQueue(INBOUND_MESSAGES_QUEUE, input.redisUrl);
  const markers = createTurnActionMarkers();
  const chatChains = new Map<string, Promise<unknown>>();

  const ctx: TurnConsumerContext = {
    publish: (payload) => publisher.publish(BUS_EVENTS_CHANNEL, payload),
    markers,
    reEnqueue: async (event, attempt) => {
      await queue.add("message.inbound", event, {
        jobId: `${event.eventId}:retry:${attempt}`,
        delay: RETRY_DELAY_MS,
      });
    },
  };

  const worker: Worker<InboundMessageEvent> = openWorker(
    INBOUND_MESSAGES_QUEUE,
    input.redisUrl,
    async (job) => {
      const event = inboundMessageEventSchema.parse(job.data);
      const attempt = attemptOf(job.id != null ? String(job.id) : undefined);
      const chain = chatChains.get(event.chat.ref) ?? Promise.resolve();
      const run = chain.then(() => handleInboundJob(event, attempt, ctx));
      // The chain must survive a failed link or every later turn in the chat
      // would inherit the rejection.
      chatChains.set(
        event.chat.ref,
        run.catch(() => undefined),
      );
      try {
        await run;
      } finally {
        if (chatChains.get(event.chat.ref) === run) chatChains.delete(event.chat.ref);
      }
    },
    { concurrency: input.concurrency ?? 8 },
  );

  return {
    async close(): Promise<void> {
      await worker.close();
      await queue.close();
      await publisher.close();
      await closeTurnActionStore().catch(() => undefined);
    },
  };
}

/**
 * Env-gated starter for boot (`register-node`): the consumer runs only when
 * both the bus and the v2 core store are configured — a v1-only deployment
 * boots exactly as before.
 */
export async function startTurnConsumerFromEnv(): Promise<TurnConsumer | null> {
  const env = getEnv();
  if (!env.REDIS_URL || !env.STORE_DATABASE_URL) return null;
  return startTurnConsumer({ redisUrl: env.REDIS_URL });
}
