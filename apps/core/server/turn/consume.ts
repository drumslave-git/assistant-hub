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
  startReplyTrace,
  type BotMessagingDeps,
  type HandleOutcome,
} from "@/features/bot-messaging/server/service";
import {
  displayNameMatchable,
  messageNamesBot,
  type AddressResult,
  type AddressSource,
} from "@/features/bot-messaging/server/addressing";
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
import { mediaKindLabel } from "@/features/vision/format";
import {
  describeAndStore,
  resolveDescribeDeps,
  type DescribeDeps,
  type MediaStorePort,
} from "@/features/vision/server/service";
import { VOICE_TURN_NOTE, VOICE_UNAVAILABLE_NOTE } from "@/features/voice/format";
import { resolveRequiredLanguage } from "@/lib/language";
import {
  HONESTY_GATE_MAX_TOKENS,
  HONESTY_GATE_TIMEOUT_MS,
} from "@/server/llm/classifier";
import { getEnv } from "@/server/env";
import type { TraceRecorder } from "@/server/trace";

import { createTurnActionMarkers, closeTurnActionStore, type TurnActionMarkers } from "./actions";
import { botTranscriptLabel, renderChatContext, renderCurrentTurn, renderHistoryWindow } from "./render";
import { tgApiMediaStore } from "./tg-media";

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
 * Media and voice (slice B) run through the owning source's internal media
 * API: bytes are read from the source, the describe/transcribe models run
 * here, and the text is written back (describe-then-drop). Interim gaps
 * until slice D (consumer-path only, which no live traffic takes yet):
 * generated images are not delivered, browser runs get no self-deleting
 * acknowledgement, voice replies deliver as text (no TTS delivery path),
 * and `#id` citations are not resolved into links.
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
  /**
   * The owning source's media over its internal API. Resolved from env when
   * absent; null-resolution (env unset) degrades media turns to their text,
   * the v1 no-token behavior.
   */
  mediaStore?: MediaStorePort;
  overrides?: {
    generateReply?: BotMessagingDeps["generateReply"];
    analyzeAddressing?: BotMessagingDeps["analyzeAddressing"];
    describeDeps?: DescribeDeps;
  };
  now?: () => Date;
}

function resolveMediaStore(ctx: TurnConsumerContext): MediaStorePort | null {
  if (ctx.mediaStore) return ctx.mediaStore;
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  return tgApiMediaStore();
}

/** What this turn's media resolves to — the v1 `visionAttachment` shape. */
interface VisionAttachment {
  note?: string;
  recognizeMessageId?: number;
  hasCaption?: boolean;
  replyTargetMessageId?: number;
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

/** Per-turn inputs the pre-pass resolves before the collaborators are built. */
interface TurnPlan {
  /** The turn's effective text (a voice transcript when transcribed). */
  effectiveText: string;
  attachment: VisionAttachment | null;
  /** Pre-opened reply trace (voice turns record transcription into it). */
  replyTrace?: TraceRecorder;
  store: MediaStorePort | null;
}

/** Build the service collaborators from the event + the (v1) brain services. */
async function buildEventDeps(
  event: InboundMessageEvent,
  ctx: TurnConsumerContext,
  turn: TurnPlan,
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
    messageText: turn.effectiveText,
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
    trace: turn.replyTrace,
    loadHistory: async (options) =>
      renderHistoryWindow(event.context.history, botLabel, options),
    loadCurrentTurn: async () =>
      renderCurrentTurn(event, { contentOverride: turn.effectiveText }),
    // Media resolved to TEXT inside the turn — the v1 `loadVision` flow over
    // the owning source's media API. Raw bytes never reach the reply request.
    loadVision: turn.attachment
      ? async (replyTrace) => {
          const va = turn.attachment!;
          const describeDeps = async (): Promise<DescribeDeps | null> =>
            ctx.overrides?.describeDeps ?? (await resolveDescribeDeps().catch(() => null));
          // Current media: recognize it and store the description on the row —
          // the source drops the bytes, so its mirror shows the text and there
          // is nothing left to backfill.
          if (va.recognizeMessageId != null) {
            let description: string | null = null;
            let mediaLabel = "media";
            let frameHint: string | null = null;
            if (turn.store) {
              const deps = await describeDeps();
              if (deps) {
                const described = await describeAndStore(
                  { chatId, telegramMessageId: va.recognizeMessageId },
                  deps,
                  { store: turn.store, trace: replyTrace },
                ).catch(() => null);
                if (described?.description) {
                  description = described.description;
                  mediaLabel = mediaKindLabel(described.kind);
                }
                // The frame-sequence hint stored at ingestion plays the v1
                // in-turn note role for video/GIF media.
                if (described && (described.kind === "animation" || described.kind === "video")) {
                  frameHint = described.visionHint;
                }
              }
            }
            if (va.hasCaption) {
              const recognized = description
                ? `Recognition of the media above: ${description}`
                : null;
              const note = [frameHint, recognized].filter(Boolean).join("\n\n");
              return { note: note || undefined };
            }
            return {
              note: description
                ? `The user sent a ${mediaLabel} (no caption). Its content: ${description}`
                : frameHint ?? undefined,
            };
          }
          // Replied-to media: resolve to its stored description, describing a
          // still-pending row right now. No ingest-on-miss over the API — a
          // never-stored target reads as unavailable (v1 covered pre-mirror
          // history by re-downloading, which only the source could do).
          if (va.replyTargetMessageId != null) {
            if (!turn.store) return { note: undefined };
            const record = await turn.store
              .getByMessage(chatId, va.replyTargetMessageId)
              .catch(() => null);
            if (!record) return null;
            let description = record.description;
            if (!description && record.status === "pending") {
              const deps = await describeDeps();
              if (deps) {
                const described = await describeAndStore(
                  { chatId, telegramMessageId: va.replyTargetMessageId },
                  deps,
                  { store: turn.store, trace: replyTrace },
                ).catch(() => null);
                description = described?.description ?? null;
              }
            }
            const label = mediaKindLabel(record.kind);
            const base = `The user is asking about the ${label} they replied to.`;
            return {
              note: description
                ? `${base} Its content: ${description}`
                : `${base} (Its content is not available.)`,
            };
          }
          return { note: va.note };
        }
      : undefined,
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
  const chatId = parseScopedRef(event.chat.ref).id;
  const media = event.message.media[0] ?? null;
  const isVoice = media?.kind === "voice";
  const store = resolveMediaStore(ctx);

  let effectiveText = event.message.content;
  let addressing = toAddressResult(event);
  let attachment: VisionAttachment | null = null;
  let replyTrace: TraceRecorder | undefined;

  if (isVoice && media) {
    // Voice: transcribe eagerly — before any addressing decision — because in
    // a group whether the message even summons the bot is only knowable from
    // the words (v1 flow). The whole turn, transcription included, is one
    // reply trace, so it opens here ahead of the service.
    replyTrace = await startReplyTrace({
      chatId: Number(chatId),
      messageId: Number(event.message.sourceMessageId),
      fromId: Number(parseScopedRef(event.sender.ref).id),
      inputSummary: "",
    });
    // Typing during the (seconds-long) transcription wait, but only when the
    // turn is certain to be answered — a DM or a reply to the bot; typing at
    // unaddressed group chatter would announce a reply that never comes.
    if (addressing.addressed) {
      void ctx.publish(lifecycleEvent(event, "accepted")).catch(() => undefined);
    }
    let transcript: string | null = media.status === "described" ? media.description : null;
    if (!transcript && media.status === "pending" && store) {
      const deps = ctx.overrides?.describeDeps ?? (await resolveDescribeDeps().catch(() => null));
      if (deps) {
        const described = await describeAndStore(
          { chatId, telegramMessageId: Number(event.message.sourceMessageId) },
          deps,
          { store, trace: replyTrace },
        ).catch(() => null);
        transcript = described?.description ?? null;
      }
    }
    effectiveText = transcript ?? "";
    if (effectiveText) replyTrace.setInputSummary(effectiveText);
    // The source's deterministic check ran without the words; with them, the
    // spoken name is as much a summons as typed — the same name check, then
    // the analyzer for the ambiguous case.
    if (
      !addressing.addressed &&
      effectiveText.trim() &&
      displayNameMatchable(event.connection.botDisplayName)
    ) {
      addressing = messageNamesBot(effectiveText, event.connection.botDisplayName)
        ? { addressed: true, source: "name", reason: "display name spoken" }
        : { addressed: false, needsAnalyzer: true };
    }
    // With a transcript the turn is answered from the words; without one the
    // bot owns up in a DM (in a group the empty text fails addressing).
    attachment = { note: transcript ? VOICE_TURN_NOTE : VOICE_UNAVAILABLE_NOTE };
  } else if (media && media.status !== "unavailable") {
    attachment = {
      recognizeMessageId: Number(event.message.sourceMessageId),
      hasCaption: Boolean(event.message.content.trim()),
    };
  } else if (event.message.replyTo?.hasMedia) {
    attachment = { replyTargetMessageId: Number(event.message.replyTo.sourceMessageId) };
  }

  const deps = await buildEventDeps(event, ctx, {
    effectiveText,
    attachment,
    replyTrace,
    store,
  });
  return handleIncomingMessage(
    {
      addressing,
      chatId: Number(chatId),
      chatType: event.chat.kind === "group" ? "supergroup" : "private",
      messageId: Number(event.message.sourceMessageId),
      fromId: Number(parseScopedRef(event.sender.ref).id),
      fromIsBot: false,
      text: effectiveText,
      // A loadable attachment makes a caption-less message real content (v1).
      hasVision: attachment != null,
      isVoice,
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
