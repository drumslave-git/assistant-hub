import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import { buildLanguageInstruction } from "@/lib/language";
import type {
  ChatContentPart,
  ChatMessage,
  ChatUsage,
  LlmRetryInfo,
} from "@/server/llm/client";
import {
  isContextOverflowError,
  llmUsageOf,
  sanitizeRequestBodyForTrace,
} from "@/server/llm/client";
import { startTrace, type TraceRecorder } from "@/server/trace";
import { RULE_ENFORCEMENT_DIRECTIVE } from "@/features/chat-rules/format";
import { ADDRESSING_CHECK_EVENT } from "../addressing-trace";
import {
  ACTION_CLAIM_ENFORCEMENT_DIRECTIVE,
  ACTION_NOT_TAKEN_REPLY,
  buildActionClaimMessages,
  parseActionClaimVerdict,
  type ActionClaimInput,
  type ActionClaimVerdict,
} from "./action-claim";
import {
  buildAnalyzerMessages,
  buildVerifierMessages,
  parseAnalyzerVerdict,
  parseVerifierVerdict,
} from "./address-analyzer";
import { checkAddressed, type AddressResult, type AddressSource, type BotIdentity } from "./addressing";
import { checkMaintenance, isOwner, type BotPolicy } from "./policy";
import { buildAddressingHint, buildSystemPrompt, hasPersonality } from "./prompt";
import { splitReply } from "./reply";

/**
 * Bot-messaging domain service — the boundary the Telegram runtime calls for
 * each incoming message. It owns addressing, ignore policy, reply generation,
 * delivery, and trace recording. Collaborators (reply generation, delivery) are
 * injected so the policy is unit-testable without a live LLM or Telegram.
 *
 * Messages the bot acts on are traced. So is every message it *asked the LLM
 * about* and then stayed silent on (see {@link BotMessagingDeps.analyzeAddressing}):
 * a bot that ignores a message someone believes they addressed is precisely the
 * complaint an operator has to be able to explain, and a decision with no trace
 * cannot be explained. Chatter rejected by the cheap deterministic checks is
 * still dropped untraced — that is the bulk of a group's traffic and tracing it
 * would bury everything else.
 */

const FEATURE = FEATURES["bot-messaging"];

// Static notices are deliberately English regardless of the chat's configured
// language, framed as the *system* speaking rather than the persona (user
// decision, 2026-07-20): the error notice is needed exactly when the LLM that
// could translate it is down, and a labeled infrastructure message does not
// read as the bot breaking its language contract.
const ERROR_REPLY =
  "⚠️ System: the bot could not generate a reply just now. Please try again.";

const MAINTENANCE_REPLY =
  "🛠️ System: the bot is in maintenance mode and is only responding to its owner right now. " +
  "Please try again later.";

/**
 * Sent in place of a rule-turn answer that claimed an action no tool performed
 * (see the enforcement in {@link handleIncomingMessage}). Same labeled-system
 * form as the notices above, for the same reason: it is the infrastructure
 * reporting a fault, not the persona speaking, so it is exempt from the chat's
 * language directive and cannot be mistaken for the bot's own voice.
 */
const RULE_NOT_APPLIED_REPLY =
  "⚠️ System: a standing rule for this chat matched this message, but the action it calls for was " +
  "not carried out. Nothing was downloaded or sent. Please try again, or ask the bot directly.";

/** The correction turn appended to a second attempt at a rule-opened reply. */
interface EnforcementTurn {
  /** The empty-handed answer the first attempt produced, shown back to the model. */
  previousAnswer: string;
  /** The instruction that follows it — see `RULE_ENFORCEMENT_DIRECTIVE`. */
  directive: string;
}

/** Result of a reply generation, as returned by the injected generator. */
export interface GeneratedReply {
  content: string;
  /** The model requested — see `ChatCompletionResult.model`. */
  model: string;
  /** What the provider reported serving — see `ChatCompletionResult.servedModel`. */
  servedModel?: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Raw provider response body, recorded verbatim in the trace. */
  responseBody?: unknown;
}

/**
 * One model round inside a reply, reported by the generator as it completes.
 *
 * A reply is not one LLM call. It is a tool turn, then another, then an answer — or
 * just an answer. The generator used to hand back only the sum, which made a
 * four-round reply and an immediate one indistinguishable on the dashboard and hid
 * a slow individual turn inside the total. Each round is recorded separately so
 * "reply · tool turn" and "reply · final answer" are measurable on their own.
 */
export interface ReplyRound {
  /** 0-based position in the loop. */
  index: number;
  /** True when this round produced the answer rather than asking for tools. */
  isFinal: boolean;
  model: string;
  servedModel?: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Raw provider response for this round. */
  responseBody?: unknown;
}

/** Normalized view of an incoming Telegram message (built by the runtime). */
export interface IncomingMessage {
  message: Message;
  chatId: number;
  chatType: string;
  messageId: number;
  fromId?: number;
  fromIsBot: boolean;
  /** Extracted user text (message text or media caption). */
  text: string;
  /**
   * Whether this turn carries visual media the bot can read (an image on the
   * message, or on a replied-to message). A media-only message with no caption is
   * still real content — it must be addressed, answered, and described like any
   * other message — so it is not treated as empty.
   */
  hasVision?: boolean;
  /**
   * Whether this turn was a voice message. `text` is then its transcript, which
   * the addressing check also reads (a voice message has no entities or caption
   * for the deterministic checks to see).
   */
  isVoice?: boolean;
}

/** A delivered Telegram message, as reported back by the runtime. */
export interface SentMessage {
  messageId: number;
  /** True when the reply was delivered as a voice bubble (TTS), not text. */
  asVoice?: boolean;
}

/**
 * A tool call executed while generating a reply, surfaced by the generator so the
 * service can record it on the reply trace. `result` is the tool's raw result.
 */
export interface ReplyToolCall {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

/** Collaborators the service needs; injected for testability. */
export interface BotMessagingDeps {
  bot: BotIdentity;
  /**
   * Generate assistant reply text. Throws on provider/config failure. Reports the
   * exact request body it sends via `onRequest` (recorded verbatim as the full
   * request trace — model, messages, and tools, not just pieces), each executed tool
   * call via `onToolCall`, and each model round via `onRound`, so the service records
   * all three on the reply trace. `onRetry` reports a transient provider failure
   * the completion path recovered from on its own, so a turn the endpoint had to
   * be asked twice for does not read as a clean one.
   */
  generateReply: (
    messages: ChatMessage[],
    onToolCall?: (call: ReplyToolCall) => void | Promise<void>,
    onRequest?: (requestBody: unknown) => void | Promise<void>,
    onRound?: (round: ReplyRound) => void | Promise<void>,
    onRetry?: (info: LlmRetryInfo) => void | Promise<void>,
    /** A round that produced neither an answer nor a tool call, being re-asked. */
    onEmptyRound?: (attempt: number) => void | Promise<void>,
  ) => Promise<GeneratedReply>;
  /**
   * Run one plain completion for the addressing analyzer (real: `chatCompletion`
   * with the configured model). Called only for a group message the deterministic
   * checks left undecided — i.e. one that could be naming the bot in another
   * alphabet or an inflected form — so a chat's ordinary traffic costs nothing.
   * Used up to twice per such message: the classification call, then the
   * verifier call on its cited word. Absent → the analyzer step is skipped
   * entirely and such a message is treated as not addressed (the pre-analyzer
   * behavior).
   */
  analyzeAddressing?: (messages: ChatMessage[]) => Promise<GeneratedReply>;
  /**
   * Run one plain completion for the honesty gate — the same classifier shape as
   * {@link analyzeAddressing}, over the drafted reply instead of the incoming
   * message (see `action-claim.ts`). Called only for a turn that made no tool
   * call at all, so a turn that did something pays nothing. Absent → the gate is
   * skipped entirely and a reply is delivered as written (the pre-gate behavior).
   */
  checkActionClaim?: (messages: ChatMessage[]) => Promise<GeneratedReply>;
  /**
   * Load the words the chat has confirmed are *not* the bot's display name (the
   * 👎 "wasn't talking to you" reports). Called only when the analyzer runs, so
   * ordinary group traffic pays nothing for it. Absent/failing → the analyzer
   * judges unaided; an unreadable exclusion list must never drop a turn.
   */
  loadAddressExclusions?: () => Promise<string[]>;
  /** Deliver a reply back to the originating chat; resolves with its delivered id. */
  sendReply: (text: string) => Promise<SentMessage>;
  /**
   * Deliver a reply as a voice bubble (TTS), present only for a voice turn with
   * a configured speech endpoint. Used for the generated reply chunks alone —
   * system notices (maintenance/error) always go through {@link sendReply} as
   * text. Implementations fall back to a text send internally, reporting which
   * form was actually delivered via {@link SentMessage.asVoice}.
   */
  sendVoiceReply?: (text: string) => Promise<SentMessage>;
  /**
   * Load the current-day conversation window as prior turns to inject before the
   * current message. Injected so the service stays free of DB/history coupling.
   * `maxMessages` caps the window to the newest N — the context-overflow retry
   * reloads with progressively smaller caps until the request fits the model.
   */
  loadHistory: (options?: { maxMessages?: number }) => Promise<{
    messages: ChatMessage[];
    count: number;
  }>;
  /**
   * Load a context block to inject as a system message after the base system
   * prompt: in a group, the participant roster (known members + operator notes);
   * in a private chat, who the bot is talking to and their known names. Resolves
   * null when there is nothing to inject. `data` is recorded verbatim on the trace
   * step. Best-effort — must never fail the reply.
   */
  loadChatContext?: () => Promise<{ content: string; data?: Record<string, unknown> } | null>;
  /**
   * Load the long-term memory of the people in this conversation (the sender, plus
   * the other known participants in a group), injected as a system message after
   * the chat context: identity first, then what is durably known about those
   * identities. Resolves null when the bot knows nothing about anyone here. `data`
   * is recorded verbatim on the trace step. Best-effort — must never fail the reply.
   */
  loadMemory?: () => Promise<{ content: string; data?: Record<string, unknown> } | null>;
  /**
   * Load the sender's latest communication preferences (distilled from their
   * 👍/👎 feedback by the self-improvement job), injected as a system message
   * after the chat context so the reply adapts to this person. Resolves null
   * when the sender has none. `data` is recorded verbatim on the trace step.
   * Best-effort — must never fail the reply.
   */
  loadSenderPreferences?: () => Promise<{ content: string; data?: Record<string, unknown> } | null>;
  /**
   * Render the current message in transcript-line format (`[#<id>] <sender> …`),
   * with its reply target resolved against the history mirror. `senderLabel`
   * feeds the group addressing hint; `data` is recorded verbatim on the trace
   * step. Best-effort — resolves null (raw text is used) rather than failing.
   */
  loadCurrentTurn?: () => Promise<{
    content: string;
    senderLabel: string | null;
    data?: Record<string, unknown>;
  } | null>;
  /**
   * Load visual media to attach to the current turn (photo/sticker/etc. on the
   * message, or on a replied-to message). Returns the image content parts to
   * splice into the user turn plus an optional note (e.g. "asking about the
   * photo they replied to"). Null when the turn carries no media. Best-effort —
   * the reply proceeds text-only if this fails.
   */
  loadVision?: (trace: TraceRecorder) => Promise<{ imageParts: ChatContentPart[]; note?: string } | null>;
  /** Persist the delivered assistant reply into the history mirror (best-effort). */
  recordReply: (input: {
    content: string;
    telegramMessageId: number;
    replyToMessageId: number;
  }) => Promise<void>;
  /**
   * Begin showing the "typing…" chat action, returning a function that stops it.
   * Called as soon as a message is addressed and stopped once the turn settles,
   * so the user sees activity during reply generation. The runtime owns
   * refreshing the action (Telegram expires it after a few seconds).
   */
  startTyping: () => () => void;
  /** Owner + maintenance-mode state, resolved from settings by the runtime. */
  policy: BotPolicy;
  /**
   * Operator-configured persona instructions (from settings), composed into the
   * system prompt for this reply. Null/absent → base prompt only.
   */
  personalityPrompt?: string | null;
  /**
   * The current chat's active specialist role instructions (per-chat
   * activation), composed into the system prompt below the persona — the stack
   * is always base + personality + specialist. Null/absent → none active.
   */
  specialistInstructions?: string | null;
  /**
   * The latest global self-correction guidelines (from the self-improvement
   * job), composed into the system prompt below the persona. Null/absent → none.
   */
  selfCorrection?: string | null;
  /**
   * The chat's standing rules, composed into a prompt block by the chat-rules
   * feature and appended last in the system prompt. Null/absent → the chat has
   * no rules.
   */
  chatRules?: string | null;
  /**
   * Apply this chat's standing rules to the current message: work out which of
   * them it triggers, which settles two things.
   *
   * 1. **Whether to answer at all.** A matched `always` rule opens a turn nobody
   *    addressed the bot in — the one path by which the bot acts on a message
   *    nobody sent to it. That is what the returned `directive` is for; it is
   *    null when nothing matched that may open a turn.
   * 2. **Whose rights the turn carries.** The runtime binds the matched rules'
   *    author as the tool authority for this turn (a rule is its author's
   *    standing order), which is why this runs on an *addressed* turn too, where
   *    its return value is unused: an owner's rule must work the same whether or
   *    not the person who triggered it happened to name the bot.
   *
   * Wired by the runtime only when one of those could actually come of it, so
   * ordinary traffic in a chat with no rules — or none that could elevate
   * anything — costs nothing. Takes the reply trace so the classification call
   * is recorded in this same turn. Best-effort: a failure resolves to null, the
   * message stays ignored and no rights are lent — acting on a failed call is
   * worse than missing a rule.
   */
  applyChatRules?: (
    trace: TraceRecorder,
    context: { addressed: boolean },
  ) => Promise<{ ruleIds: string[]; directive: string | null } | null>;
  /**
   * A system-message line giving the model the current date/time (see
   * {@link import("./prompt").buildTimeContext}), injected right before the
   * current message so it can resolve relative/named times ("in 5 minutes",
   * "tomorrow"). Null/absent → no time line (older tests, or when unavailable).
   */
  timeContext?: string | null;
  /**
   * The reply language required for this chat (the operator-configured language,
   * or the default). Injected as a strict system directive as the final message
   * before the current turn, so the bot always replies in this language. Null/
   * absent → no directive (older tests); the runtime always resolves a value.
   */
  requiredLanguage?: string | null;
  /**
   * A reply trace the runtime already opened for this message, when pre-reply
   * work had to be recorded before this service ran (eager voice transcription).
   * The service adopts it — same one-trace-per-message rule — and settles it on
   * every path, including the early ignores. Absent → opened lazily as before.
   */
  trace?: TraceRecorder;
  db?: DrizzleDb;
}

export type HandleOutcome =
  | { status: "ignored"; reason: string; source?: AddressSource }
  | { status: "replied"; text: string }
  | { status: "error"; message: string };

/** Reason codes for an ignored message (kept stable for logs/metrics). */
type IgnoreReason = "from_bot" | "no_content" | "not_addressed" | "maintenance_mode";

function ignored(reason: IgnoreReason, source?: AddressSource): HandleOutcome {
  return { status: "ignored", reason, source };
}

/**
 * Settle an undecided group message with the LLM: is the bot's display name here
 * in another alphabet, or declined? First a classification call that must cite
 * the matched word, then — when the citation is real — a focused verifier call
 * that the cited word IS the name (both in `address-analyzer.ts`). Records every
 * request and response on the trace.
 *
 * Never throws. A provider failure resolves to "not addressed" — the message
 * never clearly named the bot, so silence is the honest outcome, and barging into
 * a group conversation on the strength of a failed call is worse than missing
 * one summons.
 */
async function runAddressAnalyzer(
  incoming: IncomingMessage,
  deps: BotMessagingDeps,
  trace: TraceRecorder,
): Promise<AddressResult> {
  const analyze = deps.analyzeAddressing;
  if (!analyze) return { addressed: false };

  // Loaded here rather than per message: only an undecided message reaches the
  // analyzer, so ordinary group chatter still costs no query. Best-effort — an
  // unreadable list means the analyzer judges unaided, never that the turn fails.
  const exclusions = (await deps.loadAddressExclusions?.().catch(() => [])) ?? [];
  if (exclusions.length > 0) {
    await trace.event({
      type: "step",
      message: `addressing exclusions applied (${exclusions.length})`,
      data: { exclusions },
    });
  }

  const messages = buildAnalyzerMessages({
    bot: deps.bot,
    chatType: incoming.chatType,
    text: incoming.text,
    exclusions,
  });
  await trace.event({
    type: "llm_request",
    message: "addressing analyzer request",
    data: { messages },
  });
  try {
    const result = await analyze(messages);
    await trace.event({
      type: "llm_response",
      message: "addressing analyzer response",
      data: result.responseBody ?? { content: result.content },
      usage: { ...llmUsageOf(result), callKind: "addressing-check" },
    });
    const verdict = parseAnalyzerVerdict(result.content, {
      text: incoming.text,
      exclusions,
    });
    if (!verdict.addressed || !verdict.matchedText) {
      return {
        addressed: verdict.addressed,
        source: "analyzer",
        reason: verdict.reason,
        ...(verdict.matchedText ? { matchedText: verdict.matchedText } : {}),
      };
    }

    const verifierMessages = buildVerifierMessages(deps.bot, verdict.matchedText, exclusions);
    await trace.event({
      type: "llm_request",
      message: "addressing verifier request",
      data: { messages: verifierMessages },
    });
    const verifierResult = await analyze(verifierMessages);
    await trace.event({
      type: "llm_response",
      message: "addressing verifier response",
      data: verifierResult.responseBody ?? { content: verifierResult.content },
      usage: { ...llmUsageOf(verifierResult), callKind: "addressing-verify" },
    });
    const verified = parseVerifierVerdict(verifierResult.content, verdict.matchedText);
    return {
      addressed: verified.isDisplayName,
      source: "analyzer",
      reason: verified.isDisplayName ? verdict.reason : verified.reason,
      matchedText: verdict.matchedText,
    };
  } catch (err) {
    await trace.event({
      type: "error",
      level: "warn",
      message: "addressing analyzer failed — staying silent",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return { addressed: false, source: "analyzer", reason: "analyzer call failed" };
  }
}

/**
 * The honesty gate over a drafted reply: the turn called no tool, so does the
 * text nevertheless tell the user something was done? Prompting and parsing live
 * in `action-claim.ts`; this owns the completion and the trace events.
 *
 * Never throws, and abstains on anything it cannot read (see that module's
 * note). A guard against lies must not become a new way for honest turns to
 * fail, so a provider failure here means the reply goes out as written — the
 * state the code was in before this existed.
 */
async function runActionClaimGate(
  input: ActionClaimInput,
  deps: BotMessagingDeps,
  trace: TraceRecorder,
): Promise<ActionClaimVerdict> {
  const check = deps.checkActionClaim;
  const abstain = (reason: string): ActionClaimVerdict => ({
    claimsAction: false,
    claim: null,
    quote: null,
    reason,
  });
  if (!check) return abstain("honesty gate not wired");

  const messages = buildActionClaimMessages(input);
  await trace.event({
    type: "llm_request",
    message: "honesty gate request",
    data: { messages },
  });
  try {
    const result = await check(messages);
    await trace.event({
      type: "llm_response",
      message: "honesty gate response",
      data: result.responseBody ?? { content: result.content },
      usage: { ...llmUsageOf(result), callKind: "action-claim-check" },
    });
    return parseActionClaimVerdict(result.content, { reply: input.reply });
  } catch (err) {
    await trace.event({
      type: "error",
      level: "warn",
      message: "honesty gate failed — reply left as written",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return abstain("honesty gate call failed");
  }
}

/**
 * Open the reply trace for an incoming message — the single trace the whole
 * turn records into. Exported so the Telegram runtime can open it *before* this
 * service runs when pre-reply work must land on it (the eager voice
 * transcription), passing it in via {@link BotMessagingDeps.trace}.
 */
export async function startReplyTrace(input: {
  chatId: number | string;
  messageId: number;
  fromId?: number;
  /** The whole incoming message, never trimmed (may be updated later — voice). */
  inputSummary: string;
}): Promise<TraceRecorder> {
  return startTrace({
    feature: FEATURE.id,
    action: "reply",
    trigger: {
      kind: "telegram",
      actor: input.fromId != null ? String(input.fromId) : String(input.chatId),
      correlationId: `${input.chatId}:${input.messageId}`,
    },
    inputSummary: input.inputSummary,
  });
}

/**
 * Handle one incoming Telegram message end to end: decide, generate, deliver,
 * and trace. Cheap ignore checks run before any trace is opened — but a trace
 * the runtime already opened (voice) is settled even on those paths, so no
 * trace is ever left running.
 */
export async function handleIncomingMessage(
  incoming: IncomingMessage,
  deps: BotMessagingDeps,
): Promise<HandleOutcome> {
  const text = incoming.text.trim();

  // One trace per handled message — adopted from the runtime when it opened one
  // for pre-reply work, otherwise opened on first need — and shared by every
  // path below (analyzer, maintenance, reply): a message must never produce two.
  let trace: TraceRecorder | null = deps.trace ?? null;
  const openTrace = async (): Promise<TraceRecorder> =>
    (trace ??= await startReplyTrace({
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      fromId: incoming.fromId,
      inputSummary: text,
    }));

  /** Early ignore: nothing is traced unless a pre-opened trace must be settled. */
  const ignoredEarly = async (reason: IgnoreReason): Promise<HandleOutcome> => {
    if (trace) await trace.skip(reason);
    return ignored(reason);
  };

  if (incoming.fromIsBot) return ignoredEarly("from_bot");

  // A media-only message (no caption) still carries content — its image — so it
  // is processed like any other message rather than ignored as empty.
  if (!text && !incoming.hasVision) return ignoredEarly("no_content");

  let decision = checkAddressed(
    incoming.message,
    incoming.chatType,
    deps.bot,
    incoming.isVoice ? incoming.text : undefined,
  );
  // Maintenance mode turns the analyzer off entirely (owner included): settling
  // an undecided message costs an LLM call, and maintenance means no LLM work
  // except turns the deterministic checks already addressed. The undecided
  // message stays silent, exactly like chatter the cheap checks rejected.
  // Maintenance also turns the standing-rule match off below, for the same
  // reason.
  const applyRules = deps.policy.maintenanceModeEnabled ? undefined : deps.applyChatRules;
  let unaddressedRuleMatch: ReturnType<NonNullable<typeof applyRules>> | null = null;
  if (
    !decision.addressed &&
    decision.needsAnalyzer &&
    deps.analyzeAddressing &&
    !deps.policy.maintenanceModeEnabled
  ) {
    trace = await openTrace();
    // The standing-rule match judges the same message but shares nothing with
    // the analyzer, so the two classifications run concurrently — on a serial
    // local endpoint the turn still pays them one after the other, but nothing
    // else is stacked on top (both were measured multi-second on the live bot).
    unaddressedRuleMatch = applyRules?.(trace, { addressed: false }).catch(() => null) ?? null;
    decision = await runAddressAnalyzer(incoming, deps, trace);
  }
  // Nobody addressed the bot — but this chat may hold a standing rule that tells
  // it to act on such a message anyway ("any time someone posts X, do Y"). The
  // dep is wired only when such a rule exists, so this costs nothing in a chat
  // without one.
  let ruleDirective: string | null = null;
  if (!decision.addressed && applyRules) {
    const matched = await (unaddressedRuleMatch ??
      applyRules(await openTrace(), { addressed: false }).catch(() => null));
    if (matched?.directive) {
      ruleDirective = matched.directive;
      decision = {
        addressed: true,
        source: "chat-rule",
        reason: `standing chat rule matched (${matched.ruleIds.length})`,
      };
    }
  } else if (unaddressedRuleMatch) {
    // The analyzer said "addressed" while the rule match was still in flight.
    // Its directive is moot (the turn is open anyway), but it is settled here so
    // its authority binding cannot land in the middle of the reply — the
    // addressed-turn match below then has the last word on authority.
    await unaddressedRuleMatch;
  }

  if (!decision.addressed) {
    // Only the analyzer and rule-matching paths have a trace open here; chatter
    // the cheap checks rejected leaves nothing behind.
    if (trace) {
      await trace.event({
        type: "step",
        message: ADDRESSING_CHECK_EVENT,
        data: {
          addressed: false,
          source: decision.source,
          reason: decision.reason,
          matchedText: decision.matchedText ?? null,
          botDisplayName: deps.bot.displayName,
        },
      });
      await trace.skip(undefined, {
        outputSummary: `not addressed — ${decision.reason ?? "no reference to the bot"}`,
      });
    }
    return ignored("not_addressed", decision.source);
  }

  // Maintenance gate: the bot stays fully functional for the owner; everyone
  // else is turned away with a static notice (not silence) and generates no LLM
  // reply. The block is still traced so the operator sees who was turned away.
  const owner = isOwner({ fromId: incoming.fromId }, deps.policy);
  const maintenance = checkMaintenance({ policy: deps.policy, owner });
  if (maintenance.blocked) {
    const trace = await openTrace();
    await trace.event({
      type: "step",
      level: "success",
      message: ADDRESSING_CHECK_EVENT,
      data: {
        addressed: true,
        source: decision.source,
        reason: decision.reason,
        matchedText: decision.matchedText ?? null,
        botDisplayName: deps.bot.displayName,
      },
    });
    await trace.event({
      type: "step",
      level: "warn",
      message: "maintenance mode — blocked",
      data: { reason: maintenance.reason },
    });
    // Best-effort: let the user know it's maintenance, not a failure.
    try {
      await deps.sendReply(MAINTENANCE_REPLY);
      await trace.event({
        type: "output",
        message: "maintenance notice sent",
        data: { content: MAINTENANCE_REPLY },
      });
    } catch {
      // swallow — the trace still records the block
    }
    await trace.skip(undefined, { outputSummary: `maintenance mode — ${maintenance.reason}` });
    return ignored("maintenance_mode", decision.source);
  }

  // Addressed: show "typing…" immediately and keep it up until the turn settles.
  const stopTyping = deps.startTyping();
  try {
    const trace = await openTrace();

    try {
      // 1. Addressing decision (a passed check → green).
      await trace.event({
        type: "step",
        level: "success",
        message: ADDRESSING_CHECK_EVENT,
        data: {
          addressed: true,
          source: decision.source,
          reason: decision.reason,
          // The identity the decision was made against, so a later report knows
          // which display name the excluded word was confused with.
          botDisplayName: deps.bot.displayName,
          // The word that summoned the bot, when the analyzer found one. A later
          // "wasn't talking to you" report reads it from here to know what to
          // exclude — the whole feedback loop hangs off this field.
          matchedText: decision.matchedText ?? null,
        },
      });

      // 2. Compose the system prompt (base + operator personality + the chat's
      // active specialist + learned self-corrections) and record it so the
      // operator can see exactly what persona, role, and corrections drove the
      // reply.
      const systemPrompt = buildSystemPrompt({
        personalityPrompt: deps.personalityPrompt,
        specialistInstructions: deps.specialistInstructions,
        selfCorrection: deps.selfCorrection,
        chatRules: deps.chatRules,
      });
      await trace.event({
        type: "step",
        message: "system prompt composed",
        data: {
          personalityApplied: hasPersonality(deps.personalityPrompt),
          specialistApplied: Boolean(deps.specialistInstructions?.trim()),
          selfCorrectionApplied: Boolean(deps.selfCorrection?.trim()),
          chatRulesApplied: Boolean(deps.chatRules?.trim()),
          systemPrompt,
        },
      });

      // 2b–3b. Context loads — chat context, long-term memory, sender
      // preferences, the current turn, the history window, and vision are
      // independent reads (DB, plus the vision recognition call), so they run
      // concurrently; one reply used to pay for them back to back. The trace
      // steps are emitted after resolution, in the fixed order the prompt is
      // composed in, so the Debug event flow stays identical.
      const [chatContext, memory, senderPreferences, currentTurn, history, vision] =
        await Promise.all([
          // 2b. Chat context — injected as a system message so the model knows who
          // it is talking to: in a group, the roster of known participants (plus
          // operator notes); in a private chat, the identity of the person and
          // their known names. Skipped when there is nothing to inject.
          deps.loadChatContext?.() ?? null,
          // 2b'. Long-term memory — what the bot durably knows about the people in
          // this conversation, injected right after the chat context: the roster
          // says *who* is here, this says what is known *about* them. Skipped when
          // the bot knows nothing about anyone here.
          deps.loadMemory?.() ?? null,
          // 2b''. Sender preferences — what this person likes/dislikes about the
          // bot's replies (distilled from their feedback), injected as a system
          // message after the chat context. Skipped when the sender has none.
          deps.loadSenderPreferences?.() ?? null,
          // 2c. Current turn — the message being answered, rendered in the same
          // transcript-line format as history (id anchor, sender label, resolved
          // reply target). Falls back to the raw text when no loader is wired.
          deps.loadCurrentTurn?.() ?? null,
          // 3. The recent-history window (last 24 hours), injected as one
          // transcript message between the (cache-stable) system prompt and the
          // current message.
          deps.loadHistory(),
          // 3b. Vision — any image(s) on this turn (or a replied-to image), to
          // attach to the current user message below. Takes the reply trace so
          // the recognize pass (describe + store) records into this same flow.
          deps.loadVision?.(trace) ?? null,
          // 3c. Standing rules on a turn that was *addressed* (a rule-opened turn
          // already ran this above, and is skipped here). Its result is
          // deliberately not destructured: what it produces is a side effect in
          // the runtime — binding the matched rules' author as this turn's tool
          // authority — and that must be in place before any tool runs, which is
          // what awaiting it here guarantees.
          decision.source === "chat-rule"
            ? null
            : (deps.applyChatRules?.(trace, { addressed: true }).catch(() => null) ?? null),
        ]);

      if (chatContext) {
        await trace.event({
          type: "step",
          message: "chat context loaded",
          data: chatContext.data ?? {},
        });
      }
      if (memory) {
        await trace.event({
          type: "step",
          message: "long-term memory loaded",
          data: memory.data ?? {},
        });
      }
      if (senderPreferences) {
        await trace.event({
          type: "step",
          message: "communication preferences loaded",
          data: senderPreferences.data ?? {},
        });
      }

      // Group addressing hint: who is asking and how they addressed the bot, so
      // the model separates the requester from the people being talked about.
      const addressingHint = buildAddressingHint({
        senderLabel: currentTurn?.senderLabel ?? null,
        source: decision.source ?? "",
      });
      if (currentTurn) {
        await trace.event({
          type: "step",
          message: "current turn composed",
          data: { ...(currentTurn.data ?? { content: currentTurn.content }), addressingHint },
        });
      }

      await trace.event({
        type: "step",
        message: "history window loaded",
        data: { messageCount: history.count },
      });

      // Attach the vision media to the current user message so the model reads
      // them alongside the text.
      const userText = currentTurn?.content ?? text;
      let userContent: string | ChatContentPart[] = userText;
      // Attach the images when present; otherwise (media-only, answered from the
      // recognition text) fold the description note into the turn text.
      if (vision && (vision.imageParts.length > 0 || vision.note)) {
        const promptText = vision.note ? `${userText}\n\n${vision.note}` : userText;
        userContent =
          vision.imageParts.length > 0
            ? [{ type: "text", text: promptText }, ...vision.imageParts]
            : promptText;
        await trace.event({
          type: "step",
          message: "vision media attached",
          data: { imageCount: vision.imageParts.length, hasNote: Boolean(vision.note) },
        });
      }

      // Current date/time — injected as a system line right before the message
      // being answered, so the model has a concrete "now" to resolve relative or
      // named times against (e.g. "remind me in 5 minutes"). Recorded for debug.
      if (deps.timeContext) {
        await trace.event({
          type: "step",
          message: "time context",
          data: { timeContext: deps.timeContext },
        });
      }

      // Required reply language — a strict directive injected as the final system
      // message before the current turn (maximum recency, so it overrides the
      // language of the message, history, tool output, and personality). The
      // runtime always resolves a value (operator-configured or the default), so
      // the bot's reply language is controlled by configuration, not by whatever
      // language the user wrote in. Recorded for debug.
      const languageInstruction = deps.requiredLanguage?.trim()
        ? buildLanguageInstruction(deps.requiredLanguage)
        : null;
      if (languageInstruction) {
        await trace.event({
          type: "step",
          message: "language directive",
          data: { requiredLanguage: deps.requiredLanguage, instruction: languageInstruction },
        });
      }

      // A turn nobody addressed, opened by a standing rule: the directive naming
      // the matched rules goes in last, after the language directive, so the
      // model acts on the rule instead of joining a conversation it was not part
      // of. Absent on every ordinary (addressed) turn.
      if (ruleDirective) {
        await trace.event({
          type: "step",
          message: "opened by a standing chat rule",
          data: { reason: decision.reason, directive: ruleDirective },
        });
      }

      const composeMessages = (
        historyMessages: ChatMessage[],
        enforcement?: EnforcementTurn,
      ): ChatMessage[] => [
        // Everything above the history window is per-*chat* and changes rarely:
        // the persona, the roster, what the bot durably knows about these
        // people. That is deliberate — an endpoint reuses its KV cache for as
        // long as the token prefix is unchanged, and this is what keeps a
        // 20k-token window from being re-read on every message.
        { role: "system", content: systemPrompt },
        ...(chatContext ? [{ role: "system" as const, content: chatContext.content }] : []),
        ...(memory ? [{ role: "system" as const, content: memory.content }] : []),
        ...historyMessages,
        // Per-*sender* blocks sit below the window, not above it. They used to
        // be above, which meant every change of speaker invalidated the prefix
        // and re-read the whole history: measured on the live endpoint, an
        // alternating-speaker group went 532ms → 3923ms per turn, and moving
        // these two below it brought that back to 658ms. In a group, the
        // speaker changes on most turns.
        //
        // It also reads better: both blocks are about the turn being answered,
        // so sitting next to it is where an instruction about "now" belongs.
        ...(senderPreferences
          ? [{ role: "system" as const, content: senderPreferences.content }]
          : []),
        ...(addressingHint ? [{ role: "system" as const, content: addressingHint }] : []),
        ...(deps.timeContext ? [{ role: "system" as const, content: deps.timeContext }] : []),
        ...(languageInstruction
          ? [{ role: "system" as const, content: languageInstruction }]
          : []),
        ...(ruleDirective ? [{ role: "system" as const, content: ruleDirective }] : []),
        { role: "user", content: userContent },
        // The second pass at a rule turn the model answered without acting: its
        // own empty-handed answer, then the correction. Shown rather than merely
        // asserted — the model is being told what it just did, and the Grounding
        // rules already say its own line is not evidence of anything.
        ...(enforcement
          ? [
              { role: "assistant" as const, content: enforcement.previousAnswer },
              { role: "system" as const, content: enforcement.directive },
            ]
          : []),
      ];
      // 4. LLM request + tool calls. The generator reports the exact request body
      // it sends (via onRequest, before the provider call so the response step's
      // elapsed time reflects real provider latency) and each tool call it runs
      // (via onToolCall, as it happens). Recording both here keeps the trace's
      // event flow ordered — request, then any tool calls, then the response — and
      // the request is the *whole* body the model saw (model, messages, tools), not
      // hand-picked fields. Inline image bytes are replaced with a compact marker
      // (the real image is on the Vision page); all other content is verbatim.
      // Tool calls are counted, not just recorded: a turn a standing rule opened
      // is answerable only by doing what the rule asks, and the only way anything
      // is done is a tool call. See the enforcement below the generation.
      let toolCallCount = 0;
      const generate = (
        historyMessages: ChatMessage[],
        enforcement?: EnforcementTurn,
      ) =>
        deps.generateReply(
          composeMessages(historyMessages, enforcement),
          async (call) => {
            toolCallCount += 1;
            await trace.event({
              type: "external_call",
              level: call.ok ? "info" : "warn",
              message: `tool: ${call.name}`,
              data: { args: call.args, result: call.result },
            });
          },
          async (requestBody) => {
            await trace.event({
              type: "llm_request",
              message: "request",
              data: sanitizeRequestBodyForTrace(requestBody),
            });
          },
          // 4b. One response event per model round, as it happens. A reply that loops
          // through tools produces several; a direct answer produces one. Recording
          // the sum instead made those two shapes indistinguishable, which is exactly
          // what the performance dashboard needs to tell apart.
          async (round) => {
            await trace.event({
              type: "llm_response",
              message: round.isFinal ? "response" : `tool turn ${round.index + 1} response`,
              data: round.responseBody ?? {},
              usage: {
                ...llmUsageOf(round),
                callKind: round.isFinal ? "reply-final" : "reply-tool-turn",
              },
            });
          },
          // A recovered provider failure is still a failure that happened. Left
          // unrecorded, the trace of a turn that took two attempts is
          // indistinguishable from one that worked first time, and the endpoint
          // going flaky stays invisible until it fails outright.
          async (info) => {
            await trace.event({
              type: "step",
              level: "warn",
              message: `LLM call failed — retrying (attempt ${info.attempt} of ${info.attempts})`,
              data: { error: info.error, delayMs: info.delayMs },
            });
          },
          // Same reasoning as the retry above: a turn that needed an extra round
          // because one produced nothing must not read as a clean turn. This is
          // the signal that says whether the tool-call-in-the-reasoning failure
          // (trace `ef8634e5…`) is rare or routine.
          async (attempt) => {
            await trace.event({
              type: "step",
              level: "warn",
              message: "round produced no answer and no tool call — asking again",
              data: { attempt },
            });
          },
        );

      // 4c. Context-overflow retry: a day of history can outgrow the model's
      // context window, and the only caller-fixable lever is how much history is
      // injected. On overflow, halve the window (newest messages kept) and retry,
      // down to a final attempt with no history at all. The shrink schedule runs
      // on the *requested* cap — never on what the loader returned — so it always
      // terminates. Every retry is recorded as its own warn step (followed by the
      // retried request event), so the trace shows exactly which window size
      // finally fit. Any other failure, or overflow with history already empty,
      // propagates as before.
      let historyWindow = history;
      let windowCap = history.count;
      let reply: GeneratedReply;
      for (let attempt = 1; ; attempt++) {
        try {
          reply = await generate(historyWindow.messages);
          break;
        } catch (err) {
          if (!isContextOverflowError(err) || windowCap === 0) throw err;
          windowCap = Math.floor(windowCap / 2);
          await trace.event({
            type: "step",
            level: "warn",
            message:
              windowCap > 0
                ? `context overflow — retrying with history shrunk to ${windowCap} messages`
                : "context overflow — retrying without history",
            data: {
              attempt,
              error: err instanceof Error ? err.message : String(err),
              previousMessageCount: historyWindow.count,
              retryMessageCount: windowCap,
            },
          });
          historyWindow =
            windowCap > 0
              ? await deps.loadHistory({ maxMessages: windowCap })
              : { messages: [], count: 0 };
        }
      }

      // 4d. Rule-turn enforcement. This turn exists only because a standing rule
      // matched a message nobody addressed the bot in, so the reply's whole
      // purpose is the action the rule calls for — and the only way anything is
      // done is a tool call. Zero of them means the answer cannot be true,
      // whatever it says.
      //
      // The check is mechanical (was a rule directive injected; did `onToolCall`
      // ever fire), never a reading of the text — code judges facts, the model
      // judges language. It also cannot misfire on an ordinary turn: only a turn
      // nobody addressed gets a directive — an addressed one never does, whether
      // or not an `on-reply` rule matched it — and the guard needs one.
      if (ruleDirective && toolCallCount === 0) {
        await trace.event({
          type: "step",
          level: "warn",
          message: "rule turn answered without calling any tool — retrying",
          data: { reason: decision.reason, answer: reply.content },
        });
        reply = await generate(historyWindow.messages, {
          previousAnswer: reply.content,
          directive: RULE_ENFORCEMENT_DIRECTIVE,
        });
      }
      // Still nothing. The model's text claims an action that provably did not
      // happen, so it is not delivered — but the chat is not left in silence
      // either (user decision, 2026-08-03): the people here posted something a
      // rule promised to act on, and they are owed the truth about it rather
      // than a plausible lie or nothing at all. The notice is a labeled system
      // message like the other two, and is deliberately not mirrored into
      // history — the bot's own failure notice is not conversation.
      if (ruleDirective && toolCallCount === 0) {
        await trace.event({
          type: "step",
          level: "error",
          message: "rule turn called no tool on the retry either — answer suppressed",
          data: { reason: decision.reason, suppressedAnswer: reply.content },
        });
        const sent = await deps.sendReply(RULE_NOT_APPLIED_REPLY);
        await trace.event({
          type: "output",
          level: "warn",
          message: "send message",
          data: { content: RULE_NOT_APPLIED_REPLY, messageId: sent.messageId, asVoice: false },
        });
        // Failed, not succeeded: a rule the bot did not carry out is exactly the
        // turn an operator has to be able to find on the Debug page, and a green
        // trace is how the first one went unnoticed for a day.
        const failure = new Error(
          "A standing chat rule matched, but the model produced no tool call in two attempts — " +
            "the rule was not carried out",
        );
        await trace.fail(failure);
        return { status: "error", message: failure.message };
      }

      // 4e. Honesty gate. Everything above judges the turn by what it *was*; this
      // judges the answer by what it *says*. A turn that called no tool did
      // nothing, so an answer reporting that something was deleted, saved, or
      // scheduled is false whatever else is right about it — and the model writes
      // one anyway, several rules of the system prompt notwithstanding (the
      // measured case is in `action-claim.ts`).
      //
      // The split of labour is the same as everywhere else here: code owns the
      // mechanical fact (no tool ran — `toolCallCount`), the model owns the
      // question about language (does this text assert an action), and its answer
      // only counts when it quotes words that really are in the reply. Ordinary
      // conversation — answers, opinions, jokes, "I can't do that" — claims
      // nothing and passes untouched.
      //
      // Rule turns never reach here: theirs is the stricter mechanical check
      // above, which has already retried and returned by now.
      if (toolCallCount === 0) {
        let claim = await runActionClaimGate(
          { request: userText, reply: reply.content },
          deps,
          trace,
        );
        if (claim.claimsAction) {
          await trace.event({
            type: "step",
            level: "warn",
            message: "reply claimed an action no tool performed — retrying",
            data: { claim: claim.claim, quote: claim.quote, reason: claim.reason, answer: reply.content },
          });
          reply = await generate(historyWindow.messages, {
            previousAnswer: reply.content,
            directive: ACTION_CLAIM_ENFORCEMENT_DIRECTIVE,
          });
          // The retry that called a tool has nothing left to answer for: the
          // action happened, and what it says about it is no longer a lie the
          // mechanical signal can see. Only a second empty-handed answer is
          // re-checked, and only its *new* text — a model that took the honest
          // way out ("I could not do that") passes here, which is the point of
          // offering that exit in the directive.
          if (toolCallCount === 0) {
            claim = await runActionClaimGate(
              { request: userText, reply: reply.content },
              deps,
              trace,
            );
            // Twice through the gate and still asserting something that provably
            // did not happen. The chat is not left in silence — the same call the
            // rule path makes (user decision, 2026-08-03): the people here are
            // owed the truth rather than a plausible lie. Failed, not succeeded,
            // so the turn is findable on the Debug page instead of sitting green.
            if (claim.claimsAction) {
              await trace.event({
                type: "step",
                level: "error",
                message: "reply claimed the action again on the retry — answer suppressed",
                data: {
                  claim: claim.claim,
                  quote: claim.quote,
                  reason: claim.reason,
                  suppressedAnswer: reply.content,
                },
              });
              const sent = await deps.sendReply(ACTION_NOT_TAKEN_REPLY);
              await trace.event({
                type: "output",
                level: "warn",
                message: "send message",
                data: {
                  content: ACTION_NOT_TAKEN_REPLY,
                  messageId: sent.messageId,
                  asVoice: false,
                },
              });
              const failure = new Error(
                "The model claimed an action it never performed in two attempts — the answer was " +
                  "suppressed and nothing was done",
              );
              await trace.fail(failure);
              return { status: "error", message: failure.message };
            }
          }
        }
      }

      // A long answer is split at natural boundaries and delivered as several
      // messages — Telegram caps one message at 4096 chars, and truncating
      // silently lost content.
      const chunks = splitReply(reply.content);
      if (chunks.length === 0) chunks.push("");
      const outgoing = chunks.join("\n\n");
      // A voice turn delivers through the TTS path when wired (voice-to-voice,
      // with its own internal text fallback); everything else sends text.
      const deliver = deps.sendVoiceReply ?? deps.sendReply;
      for (const [index, chunk] of chunks.entries()) {
        const sent = await deliver(chunk);
        // 5. Delivered message(s) — full content (the spoken text, when voice).
        const label = sent.asVoice ? "send voice message" : "send message";
        await trace.event({
          type: "output",
          level: "success",
          message:
            chunks.length > 1 ? `${label} (part ${index + 1}/${chunks.length})` : label,
          data: { content: chunk, messageId: sent.messageId, asVoice: Boolean(sent.asVoice) },
        });
        // Mirror each delivered chunk into history under its own message id
        // (best-effort — never fail a delivered reply because persistence
        // hiccupped).
        try {
          await deps.recordReply({
            content: chunk,
            telegramMessageId: sent.messageId,
            replyToMessageId: incoming.messageId,
          });
        } catch {
          // swallow — the reply was delivered; the mirror is a side record
        }
      }
      await trace.succeed({ outputSummary: outgoing });
      return { status: "replied", text: outgoing };
    } catch (err) {
      await trace.fail(err);
      // Best-effort: let the user know something went wrong; never mask the
      // original failure if this send also fails.
      try {
        await deps.sendReply(ERROR_REPLY);
      } catch {
        // swallow — the trace already records the real error
      }
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    stopTyping();
  }
}
