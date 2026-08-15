import "server-only";

import type { Message } from "@grammyjs/types";

import {
  getBotPolicy,
  getClassifierRuntime,
  getLlmRuntime,
  getTimezone,
} from "@/features/settings/server/service";
import type { BotPolicy } from "@/features/settings/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { getActiveSpecialistInstructions } from "@/features/specialists/server/service";
import { listAddressingExclusionTerms } from "@/features/bot-messaging/server/exclusions-repository";
import {
  buildStandingTasksBlock,
  buildTaskTriggerDirective,
  resolveTaskAuthority,
} from "@/features/tasks/format";
import {
  buildTaskMatchMessages,
  parseTaskMatchVerdict,
} from "@/features/tasks/server/matcher";
import type { Task } from "@/features/tasks/types";
import { getActiveTasksForChat } from "@/features/tasks/server/service";
import { buildTimeContext } from "@/features/bot-messaging/server/prompt";
import {
  handleIncomingMessage,
  startReplyTrace,
  type BotMessagingDeps,
  type HandleOutcome,
  type IncomingMessage,
} from "@/features/bot-messaging/server/service";
import { registerRunAck } from "@/features/browser-agent/server/ack";
import { extractMessageUrls } from "@/features/browser-agent/urls";
import { pokeMessageIndexing } from "@/features/history/server/index-scheduler";
import { getChatMessagesByTelegramIds } from "@/features/history/server/repository";
import {
  applyMessageEdit,
  composeCurrentTurn,
  getConversationWindow,
  markIncomingMessageProcessed,
  markMessageDeleted,
  recordAssistantMessage,
  recordIncomingMessage,
} from "@/features/history/server/service";
import { formatKnownUserLabel } from "@/features/known-users/format";
import {
  getUserContext,
  getUserLabels,
  getUserLanguage,
  rememberUser,
} from "@/features/known-users/server/service";
import {
  getGroupContext,
  getGroupLanguage,
  rememberGroupActivity,
} from "@/features/known-groups/server/service";
import { getMemoryContext } from "@/features/memory/server/service";
import { getToolset } from "@/features/mcp-tools/server/service";
import { findReplyMediaMessage, messageHasVisionMedia } from "@/features/vision/detect";
import { mediaKindLabel, toVisionParts } from "@/features/vision/format";
import {
  chatModelReadsImages,
  describeAndStore,
  getMediaSuffixesForMessages,
  ingestMessageMedia,
  loadReplyTargetImages,
  resolveDescribeDeps,
} from "@/features/vision/server/service";
import { deliverGeneratedImages } from "@/features/image-gen/server/deliver";
import {
  captureFeedbackReply,
  getLatestSelfCorrectionPrompt,
  getPreferencesContext,
} from "@/features/self-improvement/server/service";
import { pokeVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { VOICE_TURN_NOTE, VOICE_UNAVAILABLE_NOTE } from "@/features/voice/format";
import { synthesizeVoiceReply } from "@/features/voice/server/speak";
import { ApiError } from "@/lib/api-error";
import { resolveRequiredLanguage } from "@/lib/language";
import {
  runClassifier,
  HONESTY_GATE_MAX_TOKENS,
  HONESTY_GATE_TIMEOUT_MS,
  type ClassifierBudget,
} from "@/server/llm/classifier";
import {
  chatCompletion,
  REPLY_CHAT_COMPLETION_TIMEOUT_MS,
  type ChatContentPart,
  type ChatMessage,
  type LlmCallTrace,
} from "@/server/llm/client";
import { getDb } from "@/db/drizzle";
import { findMessageRefs } from "@/lib/telegram";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { runWithToolContext } from "@/server/mcp/context";
import type { TraceRecorder } from "@/server/trace";

import type { IncomingUpdate, ReplyTransport } from "./transport";

/**
 * Run one per-message classification on the **classifier role** — the addressing
 * analyzer, its verifier, and the honesty gate below, plus the standing-rule
 * match further down. The call shape (reasoning off, token budget) is shared
 * with the settings probe in `server/llm/classifier.ts`; resolved here because
 * the runtime is read per call, so a role change applies without a restart.
 *
 * The role falls back to the chat backend and chat model when the operator has
 * given it neither, so an installation that never touches the Classifiers tab
 * behaves exactly as it did before the role existed.
 */
async function classify(
  messages: ChatMessage[],
  budget?: ClassifierBudget,
  trace?: LlmCallTrace,
) {
  const runtime = await getClassifierRuntime();
  if (!runtime) {
    throw ApiError.serviceUnavailable(
      "LLM is not configured — set the endpoint and model in Settings",
    );
  }
  return runClassifier(runtime, messages, budget, trace);
}

/**
 * Hard stop on tokens generated per reply round (thinking included). A guard
 * against runaway generation, not a style guide — the brevity instruction in
 * the base system prompt is what keeps ordinary replies short. Sized well above
 * the largest completions observed on the live bot (~3,000 tokens) because a
 * reply cut off mid-think surfaces as a failed turn, which is worse than a slow
 * one. User decision, 2026-08-01: cap reply completion length.
 */
const REPLY_MAX_TOKENS = 4_096;

/**
 * Transport-agnostic message-processing pipeline. This is the whole runtime
 * between the Telegram edges: remember the sender, mirror the message into
 * history, ingest + recognize any media, compose the reply context, run the
 * (tool-augmented) LLM, deliver, and mirror the reply back. It reaches Telegram
 * only through the injected {@link ReplyTransport} and the update's lazy token
 * resolver, so the exact same code runs behind a live grammy `Context` (the bot
 * manager) and behind a synthetic update + capturing sink (the test harness).
 */

/** Optional seams for tests; every field defaults to the real implementation. */
export interface ProcessOverrides {
  /**
   * Inject a deterministic reply generator instead of hitting the configured
   * LLM. When absent, the real DB-configured LLM (+ tool loop) is used — which is
   * exactly what the opt-in real-LLM flow test wants.
   */
  generateReply?: BotMessagingDeps["generateReply"];
  /**
   * Inject a deterministic addressing analyzer instead of hitting the configured
   * LLM, so a test can drive the "is this group message naming the bot?" verdict
   * without a provider. When absent, the real DB-configured LLM is used.
   */
  analyzeAddressing?: BotMessagingDeps["analyzeAddressing"];
  /**
   * Remove a feedback-menu message once its free-text answer is captured (real:
   * the bot manager's grammy adapter). Absent (no delete capability) → the menu
   * is left in place; nothing else is sent either way, since a captured answer
   * is acknowledged by the menu disappearing, not by a reply.
   */
  deleteFeedbackMenu?: (input: { chatId: string; messageId: number }) => Promise<void>;
}

/** Telegram expires a chat action after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_500;

/**
 * Begin the "typing…" refresh loop, returning its stop function. Used by the
 * reply flow (via `deps.startTyping`) and directly around the eager voice
 * transcription, which runs before the reply flow ever starts.
 */
function startTypingLoop(transport: ReplyTransport, threadId: number | undefined): () => void {
  const tick = () => transport.sendTyping({ threadId });
  tick();
  const interval = setInterval(tick, TYPING_REFRESH_MS);
  return () => clearInterval(interval);
}

/** Human label for a raw Telegram user, matching the known-user label shape. */
function labelForTelegramUser(user: {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}): string {
  return formatKnownUserLabel({
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    userId: String(user.id),
  });
}

/** Everything {@link buildDeps} needs to assemble the per-message collaborators. */
interface BuildDepsInput {
  update: IncomingUpdate;
  transport: ReplyTransport;
  policy: BotPolicy;
  personalityPrompt: string | null;
  specialistInstructions: string | null;
  selfCorrection: string | null;
  /** The chat's standing tasks, already composed into a prompt block (or null). */
  standingTasks: string | null;
  /**
   * The chat's enabled prompt tasks: `prompt` is every one of them (they all
   * shape a reply and may lend their author's rights), `message` the subset
   * that may also open a turn nobody addressed. Both empty → the task matcher
   * is not wired.
   */
  tasks: { prompt: Task[]; message: Task[] };
  timeContext: string | null;
  requiredLanguage: string | null;
  /**
   * The current turn's effective text: the message text/caption, or — for a
   * voice message — its transcript. What the current-turn composer renders.
   */
  messageText: string;
  /**
   * True when the incoming message was a voice message: the reply is then
   * delivered as a voice bubble when a speech endpoint is configured
   * (voice-to-voice, text fallback).
   */
  isVoiceTurn: boolean;
  /** Sink the `image_generate` tool fills; delivered after the reply. */
  collectImage: (base64: string) => void;
  /**
   * Runs `browse_web` enqueued this turn (filled through the tool context). A
   * non-empty list turns the reply into a transient acknowledgement of the
   * background run: sent silent, and registered per delivered message so the
   * runner deletes it once the run posts its own report.
   */
  enqueuedBrowserRuns: string[];
  visionAttachment: {
    imageParts: ChatContentPart[];
    note?: string;
    /**
     * The current message's id when its freshly-ingested media must be recognized
     * *before* the reply (pass 1 — always, so history stores the description).
     * Absent for replied-to media, which is not re-described here.
     */
    recognizeMessageId?: number;
    /** Whether to attach the images to the reply (pass 2 — only when the message has text). */
    attachToReply: boolean;
  } | null;
  /**
   * The reply trace, when the runtime opened it before the service runs (a voice
   * turn records its transcription on it first). Handed to the service so the
   * whole turn stays one trace.
   */
  trace?: TraceRecorder;
  overrides?: ProcessOverrides;
}

/**
 * Which `#<id>` citations in a reply point at messages that really exist here.
 *
 * A reply that says "the first photo was in #13488, the other two in #15114 and
 * #15115" is a good answer — but only if those references go somewhere, which is
 * why they are resolved into links at delivery. The check against the mirror is
 * the whole safety story: a model that misreads an id, or invents one, gets plain
 * text rather than a link to a message nobody can open.
 *
 * Costs one indexed lookup, and only when the reply cites something at all. Never
 * throws: a failed check drops the links, not the reply.
 */
async function resolveLinkableMessageIds(chatId: string, text: string): Promise<number[]> {
  const cited = findMessageRefs(text);
  if (cited.length === 0) return [];
  const found = await getChatMessagesByTelegramIds(getDb(), chatId, cited).catch(() => []);
  return found.map((message) => message.telegramMessageId);
}

/** Build the per-message collaborators the bot-messaging service needs. */
function buildDeps(input: BuildDepsInput): BotMessagingDeps {
  const {
    update,
    transport,
    policy,
    personalityPrompt,
    specialistInstructions,
    selfCorrection,
    standingTasks,
    tasks: { prompt: promptTasks, message: messageTasks },
    timeContext,
    requiredLanguage,
    messageText,
    isVoiceTurn,
    collectImage,
    enqueuedBrowserRuns,
    visionAttachment,
    trace,
    overrides,
  } = input;
  const message = update.message;
  const bot = update.botInfo;
  const chatId = String(message.chat.id);
  const isGroup = message.chat.type !== "private";
  const currentMessageId = message.message_id;
  const senderId = message.from?.id != null ? String(message.from.id) : null;
  const botLabel = `You (@${bot.username})`;
  const threadId = message.message_thread_id;

  /**
   * Whose rights this turn's tool calls carry, set by `applyStandingTasks` when
   * a standing task matched and read when the tool context is bound below.
   * Scoped to this one message's collaborators — not module state — and the
   * service awaits the match before generating, so it is settled before any
   * tool runs.
   */
  let taskAuthorityUserId: string | null = null;
  /**
   * Whether a `message` task opened this turn — set by `applyStandingTasks` on
   * the same pass that sets the authority above, and read when the toolset and
   * tool context are resolved.
   *
   * It changes how the turn *delivers*: a task-opened turn does not send its own
   * text at all (user decision, 2026-08-14). It gets `reply_to_message` and the
   * model's call is the delivery, which is what makes the "a task turn must call
   * a tool" guard true rather than a guess — before this, a task whose action was
   * simply to say something had no tool it could honestly call, and its correct
   * answer was suppressed (trace `d1c01591…`).
   */
  let taskOpenedTurn = false;
  /** A matched `message` task can open a turn nobody addressed the bot in. */
  const canOpenTurn = messageTasks.length > 0;

  /**
   * Register a delivered reply message as the acknowledgement of this turn's
   * browsing run(s), for the runner to delete once the run reports. Registered
   * under the newest run — the queue is FIFO, so with several enqueued that is
   * the one that settles last and the ack outlives them all. When the run beat
   * the reply to the finish line the ack is stale on arrival: delete it now
   * (best-effort — a transport without delete, or a refused delete, just leaves
   * it standing).
   */
  const registerBrowserRunAck = async (messageId: number) => {
    const runId = enqueuedBrowserRuns[enqueuedBrowserRuns.length - 1];
    if (!runId) return;
    if (registerRunAck(runId, chatId, messageId) !== "settled") return;
    try {
      await transport.deleteMessage?.({ messageId });
      await markMessageDeleted(chatId, messageId);
    } catch {
      // cosmetic — the acknowledgement simply stays in the chat
    }
  };

  /**
   * Mirror one delivered assistant message into history and settle any browsing
   * acknowledgement it just became.
   *
   * Shared by the two ways a message leaves this turn — the pipeline delivering
   * the model's answer, and a task-opened turn delivering through the
   * `reply_to_message` tool. A tool-delivered message that skipped the mirror
   * would be invisible to every later read of the thread: history search, the
   * next turn's context window, and the reaction tool's own target check.
   */
  const recordDeliveredMessage = async (telegramMessageId: number, content: string) => {
    try {
      await recordAssistantMessage({
        chatId,
        telegramMessageId,
        content,
        replyToMessageId: currentMessageId,
      });
    } finally {
      // After the mirror write (so a stale-on-arrival ack soft-deletes the row
      // it just created), but regardless of its success — losing the
      // registration would leave the ack standing forever.
      await registerBrowserRunAck(telegramMessageId);
    }
  };

  /**
   * A matched task can lend rights only if its author had rights to lend, and
   * only to somebody who does not already have them — so the owner's own
   * messages never pay for a match they cannot benefit from.
   */
  const canElevate =
    policy.ownerUserId != null &&
    senderId !== policy.ownerUserId &&
    promptTasks.some(
      (task) => task.source === "dashboard" || task.createdByUserId === policy.ownerUserId,
    );

  return {
    bot,
    policy,
    personalityPrompt,
    specialistInstructions,
    selfCorrection,
    standingTasks,
    timeContext,
    requiredLanguage,
    trace,
    // Called only for an addressed message about to be answered (after the
    // addressing/maintenance gates), so recognition here runs exactly when the
    // flow wants it: recognize → store in history → reply with images + result.
    loadVision: visionAttachment
      ? async (replyTrace) => {
          const va = visionAttachment;
          let note = va.note;
          let description: string | null = null;
          let mediaLabel = "media";
          // Pass 1 (always for the current media): recognize it and store the
          // description on the media row — this drops the stored bytes, so the
          // /history mirror shows it and there is nothing left to backfill.
          // Records into the reply trace: the recognition is part of this turn.
          if (va.recognizeMessageId != null) {
            const describeDeps = await resolveDescribeDeps().catch(() => null);
            if (describeDeps) {
              const described = await describeAndStore(
                { chatId, telegramMessageId: va.recognizeMessageId },
                describeDeps,
                { trace: replyTrace },
              ).catch(() => null);
              if (described?.description) {
                description = described.description;
                mediaLabel = mediaKindLabel(described.kind);
              }
            }
          }
          // Pass 2 (conditional): attach the images to the reply only when asked
          // (the message had text) — and only when the CHAT model is the model
          // that reads images. With the vision role pointed at a separate
          // describer, raw image parts in the reply request are what a
          // text-only chat provider rejects wholesale (trace `f37d84b9…`,
          // 2026-08-15: Z.ai 400 "messages.content.type is invalid"); the
          // recognition text above already carries what the image shows.
          if (va.attachToReply) {
            if (description) {
              const recognized = `Recognition of the media above: ${description}`;
              note = note ? `${note}\n\n${recognized}` : recognized;
            }
            const attachRaw = await chatModelReadsImages().catch(() => false);
            if (attachRaw) return { imageParts: va.imageParts, note };
            return { imageParts: [], note, imagesWithheld: true };
          }
          const recognized = description
            ? `The user sent a ${mediaLabel} (no caption). Its content: ${description}`
            : note;
          return { imageParts: [], note: recognized };
        }
      : undefined,
    // Preserve the forum-topic thread so typing shows in the right place.
    startTyping: () => startTypingLoop(transport, threadId),
    loadHistory(options) {
      return getConversationWindow({
        chatId,
        botLabel,
        excludeTelegramMessageId: currentMessageId,
        maxMessages: options?.maxMessages,
        // Turn stored media descriptions into transcript suffixes so a past image
        // turn reads as text (e.g. ` [photo: a red car…]`).
        loadMediaSuffixes: (ids) => getMediaSuffixesForMessages(chatId, ids),
      });
    },
    // Render the current message as a transcript line: id anchor, sender label,
    // and its reply target resolved against the mirror (an anchor when stored,
    // the quoted sender + full text inlined when not). Best-effort — a failure
    // falls back to the raw text rather than dropping the reply.
    loadCurrentTurn: () => {
      const from = message.from;
      const replyTo = message.reply_to_message;
      return composeCurrentTurn({
        chatId,
        telegramMessageId: currentMessageId,
        senderLabel: from && !from.is_bot ? labelForTelegramUser(from) : null,
        content: messageText,
        replyTo: replyTo
          ? {
              telegramMessageId: replyTo.message_id,
              senderLabel: replyTo.from
                ? replyTo.from.id === bot.id
                  ? botLabel
                  : labelForTelegramUser(replyTo.from)
                : null,
              text: replyTo.text ?? replyTo.caption ?? null,
              quote: message.quote?.text ?? null,
            }
          : null,
      }).catch(() => null);
    },
    // Inject the chat's identity context: in a group the known-participant
    // roster, in a private chat who the bot is talking to (so the model can
    // address them and has a reference name for the alias tool). Best-effort — a
    // lookup failure resolves null rather than dropping the reply.
    loadChatContext: isGroup
      ? () =>
          getGroupContext(chatId)
            .then((c) => (c ? { content: c.content, data: { memberCount: c.memberCount } } : null))
            .catch(() => null)
      : senderId != null
        ? () => getUserContext(senderId).catch(() => null)
        : undefined,
    // What the bot durably knows: the people here — the sender, plus the other
    // known participants in a group, so it can follow talk *about* someone it
    // knows without being asked to look them up — followed by its whole general
    // knowledge document, which is injected on every reply regardless of who is
    // talking. Best-effort — a lookup failure resolves null rather than dropping
    // the reply.
    loadMemory: () =>
      getMemoryContext({ chatId, senderId, isGroup }).catch(() => null),
    // The sender's learned communication preferences (from their 👍/👎
    // feedback), so the reply adapts to this person in groups and DMs alike.
    // Best-effort — a lookup failure resolves null rather than dropping the reply.
    loadSenderPreferences:
      senderId != null ? () => getPreferencesContext(senderId).catch(() => null) : undefined,
    recordReply: (input) => recordDeliveredMessage(input.telegramMessageId, input.content),
    generateReply:
      overrides?.generateReply ??
      (async (messages: ChatMessage[], callTrace, onToolCall) => {
        const runtime = await getLlmRuntime();
        if (!runtime) {
          throw ApiError.serviceUnavailable(
            "LLM is not configured — set the endpoint and model in Settings",
          );
        }
        const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };
        // No tools registered → a single inference (cache-friendly path). A reply
        // that needs no tool still costs one inference even when tools are offered.
        // A turn a `message` task opened delivers through `reply_to_message`;
        // an ordinary reply turn is offered no delivery tool at all, because
        // its own text is already on its way to the chat.
        const toolset = await getToolset(taskOpenedTurn ? { delivery: "reply" } : undefined);
        if (!toolset) {
          return chatCompletion(conn, {
            model: runtime.model,
            messages,
            maxTokens: REPLY_MAX_TOKENS,
            timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS,
            trace: callTrace,
          });
        }
        // Run the tool-call loop with the current chat bound, so tools only ever
        // read this conversation's data. The sender + thread are bound too, so a
        // task tool records who created a task and delivers into the right thread.
        // `collectImage` gives the image tool somewhere to put its bytes: they are
        // delivered after the reply, never through the model or the trace.
        return runWithToolContext(
          {
            chatId,
            userId: senderId,
            // The turn's correlation — every tool call's own trace carries it,
            // so the reply and its tool traces read as one process in Debug.
            correlationId: `${chatId}:${currentMessageId}`,
            // Permissions only, and only when a standing task drove this turn:
            // the task's author lends the rights, the sender keeps the identity
            // (`userId` above still decides who authored a memory or a task).
            authorityUserId: taskAuthorityUserId,
            // Hard data extracted in code: the model re-typing a URL into a tool
            // argument has corrupted one before (2026-08-01), so `browse_web`
            // takes the links from here, never from the goal text.
            messageUrls: extractMessageUrls(messageText),
            threadId,
            collectImage,
            // A task-opened turn sends nothing of its own, so this binding is
            // the only way it reaches the chat. Where the message lands is
            // decided here, not by the model: under the message that triggered
            // the task. Absent on an ordinary turn, which makes the delivery
            // tools refuse there even if a stale registry offers one.
            ...(taskOpenedTurn
              ? {
                  deliveryKind: "reply" as const,
                  deliver: async (text: string) => {
                    const sent = await transport.sendReply(text, {
                      replyToMessageId: currentMessageId,
                      threadId,
                    });
                    await recordDeliveredMessage(sent.messageId, text);
                    return { messageId: sent.messageId };
                  },
                }
              : {}),
            onBrowserRunEnqueued: (runId) => enqueuedBrowserRuns.push(runId),
          },
          () =>
          chatCompletionWithTools(conn, {
            model: runtime.model,
            messages,
            tools: toolset.tools,
            callTool: toolset.callTool,
            maxTokens: REPLY_MAX_TOKENS,
            timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS,
            trace: callTrace,
            onToolCall: (rec) =>
              onToolCall?.({ name: rec.name, args: rec.args, result: rec.result, ok: rec.ok }),
          }),
        );
      }),
    // Settles a group message that named nobody recognizable but might still be
    // calling the bot by name in another alphabet or an inflected form.
    analyzeAddressing:
      overrides?.analyzeAddressing ??
      ((messages, callTrace) => classify(messages, undefined, callTrace)),
    // Checks a drafted reply that called no tool for a claim that something was
    // done (`features/bot-messaging/server/action-claim.ts`). Same call shape as
    // the analyzer above, over the answer instead of the incoming message, on a
    // much tighter budget — a gate that cannot decide quickly is one the user is
    // better off not waiting for.
    checkActionClaim: (messages, callTrace) =>
      classify(
        messages,
        {
          maxTokens: HONESTY_GATE_MAX_TOKENS,
          timeoutMs: HONESTY_GATE_TIMEOUT_MS,
        },
        callTrace,
      ),
    // The words the chat has already reported as *not* the bot's name, so the
    // analyzer stops answering to someone else's name. Read only when the
    // analyzer actually runs (the service calls this lazily).
    loadAddressExclusions: () => listAddressingExclusionTerms().catch(() => []),
    // Standing tasks: which of them does this message trigger? The answer opens
    // a turn nobody addressed (a matched `message` task) and decides whose
    // rights the turn's tool calls carry (`taskAuthorityUserId` above). Wired
    // only when one of those could come of it, so ordinary traffic pays
    // nothing. Like the analyzer, a plain completion: one classification of one
    // message, no tools, no history.
    applyStandingTasks:
      canOpenTurn || canElevate
        ? async (replyTrace, { addressed }) => {
            // Nothing to be gained on this branch: an addressed turn where no
            // task could lend rights, or an unaddressed one where none could
            // open the turn. Skipped before the call, so it costs nothing.
            if (addressed ? !canElevate : !canOpenTurn) return null;
            // The matcher judges the message's words; a message with none (a bare
            // photo or sticker) has nothing for a task to quote, so it is left
            // alone without spending a call.
            const text = messageText.trim();
            if (!text) return null;
            // Same role as the addressing checks above: one classification of
            // one message, and the third such call an ordinary group message
            // can pay for.
            const runtime = await getClassifierRuntime();
            if (!runtime) return null;

            // Every enabled prompt task is offered, not only the `message`
            // ones: an `on-reply` task cannot open a turn but still lends its
            // author's rights to what it asks for on a turn the bot was
            // addressed in.
            const offered = addressed ? promptTasks : messageTasks;
            // Names for the people involved: the sender, and anyone a task is
            // limited to. A task whose condition is *who is speaking* is
            // unjudgeable without them — the model would be shown an
            // instruction with no visible trigger and would rightly decline it
            // (trace `c08283a8…`). One indexed read next to a classification
            // call; unreadable degrades to no names rather than no match.
            const labels = await getUserLabels([
              ...(senderId ? [senderId] : []),
              ...offered.flatMap((task) => task.targetUserIds),
            ]).catch(() => new Map<string, string>());
            const matchable = offered.map((task) => ({
              id: task.id,
              instruction: task.instruction,
              targetLabels: task.targetUserIds.map((id) => labels.get(id) ?? `User ${id}`),
            }));
            const messages = buildTaskMatchMessages({
              tasks: matchable,
              text,
              chatType: message.chat.type,
              senderLabel: senderId ? labels.get(senderId) : null,
            });
            const result = await runClassifier(runtime, messages, undefined, {
              recorder: replyTrace,
              callKind: "task-match",
              label: "task match",
            });

            const verdict = parseTaskMatchVerdict(result.content, { tasks: matchable, text });
            const matched = offered.filter((task) => verdict.matchedIds.includes(task.id));
            // A task is its author's standing order: the actions it calls for
            // run with the author's rights, not the sender's. Bound here, read
            // by the tool context when the generator runs (both inside this
            // closure's scope, and the service awaits this before generating).
            const authority = resolveTaskAuthority(matched, policy.ownerUserId ?? null);
            taskAuthorityUserId = authority;
            await replyTrace.event({
              type: "step",
              level: matched.length > 0 ? "success" : "info",
              message: "task match",
              data: {
                offered: matchable,
                matchedIds: verdict.matchedIds,
                reason: verdict.reason,
                // Whose rights the turn now carries — null when the sender's own.
                authorityUserId: authority,
              },
            });
            if (matched.length === 0) return null;
            // Only a `message` task may open a turn nobody addressed.
            const opening = matched.filter((task) => task.triggerKind === "message");
            // Read below when the toolset and tool context are resolved: this is
            // the turn that delivers through `reply_to_message` instead of by
            // answering. Set here for the same reason the authority is — this
            // closure is the only place that knows, and the service awaits it
            // before generating.
            taskOpenedTurn = opening.length > 0;
            return {
              taskIds: verdict.matchedIds,
              directive: opening.length > 0 ? buildTaskTriggerDirective(opening) : null,
            };
          }
        : undefined,
    async sendReply(text: string) {
      return transport.sendReply(text, {
        replyToMessageId: currentMessageId,
        // A turn that enqueued a browsing run replies only with an "on it"
        // acknowledgement — no ping; the run's own report is the notification.
        silent: enqueuedBrowserRuns.length > 0,
        linkableMessageIds: await resolveLinkableMessageIds(chatId, text),
      });
    },
    // Voice-to-voice (user decision): a voice message is answered with a voice
    // bubble when the speech endpoint is configured. Synthesis or delivery
    // failing degrades to the plain text reply — the answer always arrives.
    sendVoiceReply: isVoiceTurn
      ? async (text: string) => {
          const audio = await synthesizeVoiceReply({
            chatId,
            correlationId: `${chatId}:${currentMessageId}`,
            text,
          });
          if (audio) {
            try {
              const sent = await transport.sendVoice(audio, {
                replyToMessageId: currentMessageId,
                ...(threadId != null ? { threadId } : {}),
              });
              return { messageId: sent.messageId, asVoice: true };
            } catch {
              // fall through to the text delivery below
            }
          }
          const sent = await transport.sendReply(text, {
            replyToMessageId: currentMessageId,
            silent: enqueuedBrowserRuns.length > 0,
            linkableMessageIds: await resolveLinkableMessageIds(chatId, text),
          });
          return { messageId: sent.messageId, asVoice: false };
        }
      : undefined,
  };
}

/**
 * Handle one incoming message end to end through the transport-agnostic pipeline.
 * Maps the normalized update to the bot-messaging service's input, wiring the
 * real (or injected) collaborators. Returns the service outcome so callers/tests
 * can assert on it (the bot manager ignores it).
 */
export async function processUpdate(
  update: IncomingUpdate,
  transport: ReplyTransport,
  overrides?: ProcessOverrides,
): Promise<HandleOutcome> {
  const message = update.message;

  // Live traffic: push the idle background runs out and yield any batch in
  // flight, so they only ever run while the bot is quiet.
  pokeVisionBackfill();
  pokeMessageIndexing();

  // Remember every human sender + mirror every human message (addressed or not),
  // so the operator sees who talks to the bot and the history window has the full
  // running conversation. Both are best-effort and must not block handling.
  const from = message.from;
  const fromIsBot = from?.is_bot ?? false;
  const text = message.text ?? message.caption ?? "";
  const chat = message.chat;
  const chatId = String(chat.id);
  const hasMedia = messageHasVisionMedia(message);
  if (from && !from.is_bot) {
    await rememberUser({
      userId: String(from.id),
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    });
    // In a group, also remember the group and record this sender as a member, so
    // the operator sees the bot's groups and the roster is available for context.
    // Runs after rememberUser so the membership FK to known_users is satisfied.
    if (chat.type === "group" || chat.type === "supergroup") {
      await rememberGroupActivity({
        chatId,
        title: chat.title,
        type: chat.type,
        userId: String(from.id),
      });
    }
    // Mirror the message when it has text or media (a media-only message still
    // belongs in the transcript — its image is described separately). The
    // remember/mirror trio is best-effort: the capture services swallow their
    // own failures, and the mirror is caught here — a DB hiccup degrades to a
    // reply without this message in history rather than dropping the update.
    if (text.trim() || hasMedia) {
      // `processed: false` takes the live-processing hold: the vision backfill
      // leaves this message's media alone until the `finally` below releases it.
      // A mirror failure degrades further than before: the media FK then rejects
      // the media row too, so this turn gets no vision/transcript (recorded on
      // the reply trace) — media must never float free of the mirror.
      await recordIncomingMessage({
        chatId,
        telegramMessageId: message.message_id,
        userId: String(from.id),
        content: text,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        sentAt: new Date(message.date * 1000),
        hasMedia,
        processed: false,
      }).catch((err) => {
        console.warn(`History mirror failed for ${chatId}:${message.message_id}:`, err);
        return null;
      });
    }
  }

  // The reply trace — opened early for a voice turn, so the transcription that
  // must run before any addressing decision records into the same trace the
  // reply then continues in. Every other turn gets it opened lazily by the
  // service. Outside the `try` so the catch can settle it if the pipeline dies
  // between opening and the service (which otherwise settles it on every path).
  let replyTrace: TraceRecorder | null = null;
  try {
  // Feedback capture: a reply to an `awaiting_text` feedback menu from the
  // reactor is the free-text answer to the 👍/👎 menu — record it and stop, the
  // message is not a turn for the bot to answer (it stays mirrored above). The
  // menu has served its purpose and is removed; nothing is sent back.
  if (from && !from.is_bot && message.reply_to_message && text.trim()) {
    const captured = await captureFeedbackReply({
      chatId,
      menuMessageId: message.reply_to_message.message_id,
      userId: String(from.id),
      text,
    }).catch(() => null);
    if (captured) {
      await overrides?.deleteFeedbackMenu?.({
        chatId,
        messageId: captured.menuMessageId,
      }).catch(() => undefined);
      return { status: "ignored", reason: "feedback_captured" };
    }
  }

  // Vision: ingest this message's media (passive, stored as base64) and resolve
  // the image(s) to attach to the current turn — either on the message itself or
  // on a replied-to image. The bot token (from settings) is needed to download
  // Telegram files. Best-effort — any failure just yields a text-only reply.
  let visionAttachment:
    | {
        imageParts: ChatContentPart[];
        note?: string;
        /** Current media to describe+store (pass 1). Always set for current media. */
        recognizeMessageId?: number;
        /** Whether to attach the images to the reply (pass 2). */
        attachToReply: boolean;
      }
    | null = null;
  const isVoiceMessage = Boolean(message.voice);
  let voiceTranscript: string | null = null;
  const replyMedia = hasMedia ? null : findReplyMediaMessage(message);
  // Media from another bot is never ingested: the bot never answers bots, so
  // describing/transcribing it would spend LLM calls on turns that do not
  // exist — and the mirror stores no row for bot messages, which the media FK
  // now enforces structurally.
  if (!fromIsBot && (hasMedia || replyMedia)) {
    const token = await update.resolveToken().catch(() => null);
    if (token) {
      if (hasMedia) {
        const ingested = await ingestMessageMedia({
          token,
          chatId,
          telegramMessageId: message.message_id,
          message,
        }).catch(() => null);
        if (isVoiceMessage) {
          // Voice: transcribe eagerly — before any addressing decision — because
          // in a group whether the message even summons the bot ("hey <name>, …")
          // is only knowable from the words. The transcript lands on the media
          // row (bytes dropped), so history annotates it with no backfill needed.
          // The whole turn — transcription included — is one reply trace, so it
          // is opened here, ahead of the service.
          replyTrace = await startReplyTrace({
            chatId: chat.id,
            messageId: message.message_id,
            fromId: from?.id,
            // The real input is the transcript, which does not exist yet;
            // filled in via setInputSummary once transcription lands.
            inputSummary: "",
          });
          if (ingested?.media) {
            // Transcription is a real wait (seconds) that happens before the
            // reply flow's own typing starts. When the turn is certain to be
            // answered — a DM, or a group reply to the bot — show typing now;
            // for other group voice messages addressing is still unknown, and
            // typing at unaddressed chatter would announce a reply that never
            // comes.
            const willReply =
              chat.type === "private" ||
              message.reply_to_message?.from?.id === update.botInfo.id;
            const stopTranscribeTyping = willReply
              ? startTypingLoop(transport, message.message_thread_id)
              : null;
            try {
              const describeDeps = await resolveDescribeDeps().catch(() => null);
              if (describeDeps) {
                const transcribed = await describeAndStore(
                  { chatId, telegramMessageId: message.message_id },
                  describeDeps,
                  { trace: replyTrace },
                ).catch(() => null);
                voiceTranscript = transcribed?.description ?? null;
              }
            } finally {
              stopTranscribeTyping?.();
            }
          } else {
            // No stored row to transcribe from: download failed (`unavailable`
            // row) or the row could not be stored at all (mirror row missing —
            // the FK refused). Recorded on the turn's trace, not just implied
            // by the fallback reply.
            await replyTrace.event({
              type: "error",
              level: "warn",
              message: ingested
                ? "voice media could not be stored — transcription skipped"
                : "voice message could not be downloaded — transcription skipped",
            });
          }
          // With a transcript the turn is answered from the words; without one
          // (transcode/LLM failure — the row stays pending for the backfill) the
          // bot owns up in a DM. In a group the empty text fails addressing, so
          // no apology barges into the conversation.
          visionAttachment = {
            imageParts: [],
            note: voiceTranscript ? VOICE_TURN_NOTE : VOICE_UNAVAILABLE_NOTE,
            attachToReply: false,
          };
        } else if (ingested && ingested.images.length > 0) {
          // Pass 1 (always): recognize + store the current media in history.
          // Pass 2 (conditional): attach the images to the reply only when the
          // message also carries text (a real question). A media-only message is
          // answered from the recognition text alone — one vision pass.
          visionAttachment = {
            imageParts: toVisionParts(ingested.images),
            note: ingested.note ?? undefined,
            recognizeMessageId: message.message_id,
            attachToReply: Boolean(text.trim()),
          };
        }
      } else if (replyMedia) {
        const loaded = await loadReplyTargetImages({ token, chatId, message: replyMedia }).catch(
          () => null,
        );
        // Images attach to the turn; a replied-to voice message resolves to a
        // transcript note instead (there is nothing to show).
        if (loaded && (loaded.images.length > 0 || loaded.note)) {
          const label = mediaKindLabel(loaded.kind);
          const base =
            loaded.images.length > 0
              ? `The user is asking about the ${label} they replied to (shown here).`
              : `The user is asking about the ${label} they replied to.`;
          // A replied-to reference is explicit — always show the media to the reply.
          visionAttachment = {
            imageParts: toVisionParts(loaded.images),
            note: loaded.note ? `${base} ${loaded.note}` : base,
            attachToReply: true,
          };
        }
      }
    }
  }

  // A voice message's effective text is its transcript: addressing, the current
  // turn, and the reply all read the words as if they had been typed.
  const effectiveText = isVoiceMessage ? (voiceTranscript ?? "") : text;
  // The pre-opened voice trace was created before its input existed.
  if (effectiveText) replyTrace?.setInputSummary(effectiveText);

  const incoming: IncomingMessage = {
    message,
    chatId: chat.id,
    chatType: chat.type,
    messageId: message.message_id,
    fromId: from?.id,
    fromIsBot,
    text: effectiveText,
    // A loadable image (on this message or a replied-to one) makes a caption-less
    // message real content, so it is answered and described like any other.
    hasVision: visionAttachment != null,
    isVoice: isVoiceMessage,
  };

  // The reply language for this chat: the group's setting for a group, the user's
  // DM setting for a private chat (a private chat's id equals the user id). Falls
  // back to the default when unset — the bot is always given a language directive.
  const isGroup = chat.type !== "private";
  const [
    policy,
    personalityPrompt,
    specialistInstructions,
    selfCorrection,
    standingTaskSets,
    timezone,
    storedLanguage,
  ] = await Promise.all([
    getBotPolicy(),
    getActivePersonalityPrompt(),
    // The chat's active specialist role — stacked onto the persona, never
    // replacing it. Best-effort: an unreadable activation degrades to no role.
    getActiveSpecialistInstructions(chatId).catch(() => null),
    getLatestSelfCorrectionPrompt().catch(() => null),
    // The chat's standing tasks (its own + the global ones), narrowed to the
    // ones this sender's messages can trigger — a task naming other people is
    // never composed into this turn at all. Best-effort: an unreadable set
    // degrades to no tasks rather than failing the turn.
    getActiveTasksForChat(chatId, from?.id != null ? String(from.id) : null).catch(() => ({
      prompt: [],
      message: [],
    })),
    getTimezone().catch(() => "UTC"),
    (isGroup ? getGroupLanguage(chatId) : getUserLanguage(chatId)).catch(() => null),
  ]);
  const timeContext = buildTimeContext(new Date(), timezone);
  const requiredLanguage = resolveRequiredLanguage(storedLanguage);

  // Recognition of the current message's media happens *before* the reply, inside
  // `loadVision` (only for an addressed message that also carries text): it is
  // described, stored in history, and its bytes dropped. A media-only message is
  // answered in one pass and its media, like unaddressed media, is described later
  // by the backfill job.
  // Images the model draws mid-reply land here (out-of-band — see the tool
  // context's `collectImage`) and are delivered once the reply is out, so the
  // acknowledgement arrives before the picture it acknowledges.
  const generatedImages: string[] = [];
  // Runs `browse_web` enqueued during this turn — the reply then becomes a
  // silent, self-deleting acknowledgement (see BuildDepsInput).
  const enqueuedBrowserRuns: string[] = [];
  const outcome = await handleIncomingMessage(
    incoming,
    buildDeps({
      update,
      transport,
      policy,
      personalityPrompt,
      specialistInstructions,
      selfCorrection,
      standingTasks: buildStandingTasksBlock(standingTaskSets.prompt),
      tasks: standingTaskSets,
      timeContext,
      requiredLanguage,
      messageText: effectiveText,
      isVoiceTurn: isVoiceMessage,
      collectImage: (base64) => generatedImages.push(base64),
      enqueuedBrowserRuns,
      visionAttachment,
      trace: replyTrace ?? undefined,
      overrides,
    }),
  );

  if (generatedImages.length > 0) {
    await deliverGeneratedImages({
      transport,
      chatId,
      images: generatedImages,
      threadId: message.message_thread_id,
    });
  }

  return outcome;
  } catch (err) {
    // The service settles the trace on every one of its paths; this catches a
    // failure *around* it (settings loads, transcription plumbing) so a
    // pre-opened trace is never left running. Settling twice is a harmless no-op.
    if (replyTrace) await replyTrace.fail(err).catch(() => undefined);
    throw err;
  } finally {
    // Release the live-processing hold taken by the mirror write above — on
    // every exit path (replied, ignored, feedback-captured, errored). From here
    // on, any media still `pending` is a leftover the backfill may claim.
    if (from && !from.is_bot && (text.trim() || hasMedia)) {
      await markIncomingMessageProcessed(chatId, message.message_id).catch(() => undefined);
    }
  }
}

/**
 * Mirror a Telegram `edited_message` into history so the stored conversation
 * tracks edits 1:1. Only text/caption edits are mirrored; edits with no textual
 * content are ignored.
 */
export async function processEditedUpdate(edited: Message): Promise<void> {
  const content = edited.text ?? edited.caption ?? "";
  if (!content.trim()) return;

  await applyMessageEdit(
    {
      chatId: String(edited.chat.id),
      telegramMessageId: edited.message_id,
      content,
      editedAt: new Date((edited.edit_date ?? edited.date) * 1000),
    },
    {
      kind: "telegram",
      actor: edited.from ? String(edited.from.id) : String(edited.chat.id),
      correlationId: `${edited.chat.id}:${edited.message_id}`,
    },
  ).catch((err) => {
    console.error(
      "Failed to mirror edited message:",
      err instanceof Error ? err.message : String(err),
    );
  });
}
