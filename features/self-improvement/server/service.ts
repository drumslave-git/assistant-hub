import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import type { AddressingExclusion } from "@/features/bot-messaging/exclusions";
import {
  deleteAddressingExclusion,
  listAddressingExclusions,
} from "@/features/bot-messaging/server/exclusions-repository";
import { getChatMessageByTelegramId } from "@/features/history/server/repository";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getLlmRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { formatPreferencesContext } from "../format";
import {
  buildMenuKeyboard,
  menuText,
  MENU_AWAITING_TEXT,
  OTHER_OPTION,
  type MenuKeyboard,
  type MenuSelection,
} from "../menu";
import { normalizeModelName } from "../model-name";
import { optionsForReaction, topicForAnswer } from "../options";
import type { CommunicationPreference, SelfCorrection, UserFeedback } from "../types";
import { recordAddressingExclusion, type AddressingReportOutcome } from "./addressing-report";
import { getReplyTrace } from "./exchange";
import { scheduleReflection } from "./reflect";
import {
  completeFeedback,
  findAwaitingFeedbackByMenu,
  getFeedback,
  getLatestCorrection,
  getLatestPreference,
  listFeedbacks,
  listLatestPreferences,
  markFeedbackAwaitingText,
  setFeedbackMenuMessage,
  upsertFeedback,
} from "./repository";
import { captureReplyInputSchema, reactionInputSchema, type CaptureReplyInput, type ReactionInput } from "./schema";

/**
 * Self-improvement domain service — the feedback-collection flows (reaction →
 * menu → answer) and the prompt-injection reads (latest self-correction, latest
 * per-user preferences). The daily incorporation job lives in `analyze.ts`.
 *
 * Telegram side effects are injected (the transport adapters own the actual
 * API calls), so every flow runs unchanged in the bot-less simulation harness.
 */

const FEEDBACK_FEATURE = FEATURES["user-feedback"];

/**
 * Resolve the clean model name that generated a bot reply: the reply trace's
 * `llm_response` usage records the provider-reported model; fall back to the
 * currently configured model. Informational only — never blocks the flow.
 */
export async function resolveReplyModel(
  chatId: string,
  telegramMessageId: number,
  db: DrizzleDb = getDb(),
): Promise<string> {
  const trace = await getReplyTrace(db, chatId, telegramMessageId);
  const model = trace?.events.find((e) => e.usage?.model)?.usage?.model;
  if (model) return normalizeModelName(model);
  const runtime = await getLlmRuntime(db).catch(() => null);
  return normalizeModelName(runtime?.model);
}

/** Outcome of a reaction: a menu was sent, or why not. */
export type ReactionOutcome =
  | { status: "menu_sent"; feedback: UserFeedback; menuMessageId: number }
  | { status: "ignored"; reason: "not_bot_message" | "unknown_message" };

/** Transport ops the reaction flow needs (Telegram adapter or a test fake). */
export interface ReactionFlowDeps {
  /** Post the menu into the chat as a reply to the reacted message. */
  sendMenu: (input: {
    text: string;
    keyboard: MenuKeyboard;
    replyToMessageId: number;
  }) => Promise<{ messageId: number }>;
  db?: DrizzleDb;
}

/**
 * Handle a 👍/👎 reaction on a message: when it targets one of the bot's own
 * replies, open (or reopen) a feedback row and post the options menu. Traced.
 */
export async function handleFeedbackReaction(
  rawInput: ReactionInput,
  deps: ReactionFlowDeps,
): Promise<ReactionOutcome> {
  const input = reactionInputSchema.parse(rawInput);
  const db = deps.db ?? getDb();

  // Only the bot's own replies collect feedback — a thumbs-up on a human
  // message (or a message we never mirrored) is silently ignored.
  const target = await getChatMessageByTelegramId(db, input.chatId, input.telegramMessageId);
  if (!target) return { status: "ignored", reason: "unknown_message" };
  if (target.role !== "assistant") return { status: "ignored", reason: "not_bot_message" };

  const trace = await startTrace(
    {
      feature: FEEDBACK_FEATURE.id,
      action: "menu",
      trigger: {
        kind: "telegram",
        actor: input.userId,
        correlationId: `${input.chatId}:${input.telegramMessageId}`,
      },
      inputSummary: `${input.reaction === "up" ? "👍" : "👎"} on message ${input.telegramMessageId}`,
    }
  );
  try {
    const model = await resolveReplyModel(input.chatId, input.telegramMessageId, db);
    const feedback = await upsertFeedback(db, {
      id: randomUUID(),
      chatId: input.chatId,
      telegramMessageId: input.telegramMessageId,
      userId: input.userId,
      reaction: input.reaction,
      model,
    });
    await trace.event({
      type: "db",
      message: "feedback row opened",
      data: { feedbackId: feedback.id, reaction: feedback.reaction, model },
    });

    const sent = await deps.sendMenu({
      text: menuText(feedback.reaction),
      keyboard: buildMenuKeyboard(feedback.reaction, feedback.id),
      replyToMessageId: input.telegramMessageId,
    });
    await setFeedbackMenuMessage(db, feedback.id, sent.messageId);
    await trace.event({
      type: "output",
      level: "success",
      message: "feedback menu sent",
      data: { menuMessageId: sent.messageId, options: optionsForReaction(feedback.reaction) },
    });

    publishEvent(FEEDBACK_FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: `menu sent for ${feedback.reaction === "up" ? "👍" : "👎"}`,
      relatedIds: { [FEEDBACK_FEATURE.relatedIdsKey]: [feedback.id] },
    });
    return { status: "menu_sent", feedback, menuMessageId: sent.messageId };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** Outcome of a menu press, mapped by the transport to callback-query answers. */
export type MenuPressOutcome =
  | { status: "recorded"; feedback: UserFeedback }
  | { status: "awaiting_text"; feedback: UserFeedback; instruction: string }
  | { status: "not_yours" }
  | { status: "unknown" };

/** Transport ops the menu-press flow needs. */
export interface MenuPressDeps {
  /** Rewrite the menu message (the reply instruction), dropping the keyboard when asked. */
  editMenu: (input: { text: string; keyboard: MenuKeyboard | null }) => Promise<void>;
  /**
   * Remove the menu message once the answer is stored. The answer is already
   * persisted by then, so the caller makes this best-effort: a chat left with a
   * stale menu is cosmetic, and must not fail the flow.
   */
  deleteMenu: () => Promise<void>;
  db?: DrizzleDb;
}

/**
 * Handle a press on a feedback menu. Only the reactor may answer; a predefined
 * option completes the row, "Other" flips it to awaiting a reply. Traced when
 * the press changes state.
 */
export async function handleMenuPress(
  selection: MenuSelection,
  presserUserId: string,
  deps: MenuPressDeps,
): Promise<MenuPressOutcome> {
  const db = deps.db ?? getDb();
  const feedback = await getFeedback(db, selection.feedbackId);
  if (!feedback || feedback.status === "completed") return { status: "unknown" };
  if (feedback.userId !== presserUserId) return { status: "not_yours" };

  const trace = await startTrace(
    {
      feature: FEEDBACK_FEATURE.id,
      action: "answer",
      trigger: {
        kind: "telegram",
        actor: presserUserId,
        correlationId: `${feedback.chatId}:${feedback.telegramMessageId}`,
      },
      inputSummary:
        selection.option === OTHER_OPTION ? "Other — write your own" : `option ${selection.option}`,
    }
  );
  try {
    if (selection.option === OTHER_OPTION) {
      await markFeedbackAwaitingText(db, feedback.id);
      await deps.editMenu({ text: MENU_AWAITING_TEXT, keyboard: null });
      await trace.event({
        type: "step",
        message: "awaiting free-text reply",
        data: { feedbackId: feedback.id },
      });
      publishEvent(FEEDBACK_FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: "awaiting free-text reply",
        relatedIds: { [FEEDBACK_FEATURE.relatedIdsKey]: [feedback.id] },
      });
      return {
        status: "awaiting_text",
        feedback: { ...feedback, status: "awaiting_text" },
        instruction: MENU_AWAITING_TEXT,
      };
    }

    const options = optionsForReaction(feedback.reaction);
    const chosen = options[selection.option];
    if (!chosen) {
      await trace.skip("unknown option index");
      return { status: "unknown" };
    }
    const topic = topicForAnswer(chosen);
    const updated = await completeFeedback(db, feedback.id, chosen, topic);
    // The answer is stored; the menu has done its job and goes away (the press
    // is acknowledged by the transport's toast, not by a message).
    await deps.deleteMenu();
    await trace.event({
      type: "output",
      level: "success",
      message: "feedback recorded",
      data: { feedbackId: feedback.id, feedback: chosen, topic },
    });
    const answered = updated ?? feedback;

    // "Wasn't talking to you" is a routing report, and it is acted on here and
    // now: the word that mis-triggered the analyzer is filed as an exclusion, so
    // the next message using it does not summon the bot again. Nothing reflects
    // on it and no fold reads it — there is no reply quality to learn from a
    // reply that should never have been sent (user decision, 2026-07-26).
    let report: AddressingReportOutcome | null = null;
    if (topic === "addressing") {
      report = await recordAddressingExclusion(db, answered, trace);
    } else {
      scheduleReflection(answered, db);
    }

    publishEvent(FEEDBACK_FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary:
        report?.status === "excluded" || report?.status === "already_excluded"
          ? `${chosen} — "${report.exclusion.term}" excluded from addressing`
          : report
            ? `${chosen} — ${report.reason}`
            : chosen,
      relatedIds: { [FEEDBACK_FEATURE.relatedIdsKey]: [feedback.id] },
    });
    return { status: "recorded", feedback: answered };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** A captured free-text answer, or null. */
export interface CapturedFeedback {
  feedback: UserFeedback;
  /** The menu message to clean up — it has served its purpose. */
  menuMessageId: number;
}

/**
 * Try to capture an incoming message as the free-text answer to an
 * `awaiting_text` feedback: the message must reply to the menu message and come
 * from the reactor. Returns null when the message is not a feedback answer —
 * the caller then processes it as a normal turn. Traced when captured.
 *
 * Nothing is sent back: this flow has no callback query to toast, and the user's
 * own reply is already in the chat, so the answer is acknowledged by the menu
 * message disappearing (the caller deletes it).
 */
export async function captureFeedbackReply(
  rawInput: CaptureReplyInput,
  db: DrizzleDb = getDb(),
): Promise<CapturedFeedback | null> {
  const parsed = captureReplyInputSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const input = parsed.data;

  const awaiting = await findAwaitingFeedbackByMenu(
    db,
    input.chatId,
    input.menuMessageId,
    input.userId,
  );
  if (!awaiting) return null;

  const trace = await startTrace(
    {
      feature: FEEDBACK_FEATURE.id,
      action: "answer",
      trigger: {
        kind: "telegram",
        actor: input.userId,
        correlationId: `${awaiting.chatId}:${awaiting.telegramMessageId}`,
      },
      inputSummary: input.text,
    }
  );
  try {
    const updated = await completeFeedback(db, awaiting.id, input.text);
    await trace.event({
      type: "output",
      level: "success",
      message: "feedback recorded (free text)",
      data: { feedbackId: awaiting.id, feedback: input.text },
    });
    publishEvent(FEEDBACK_FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: input.text,
      relatedIds: { [FEEDBACK_FEATURE.relatedIdsKey]: [awaiting.id] },
    });
    const answered = updated ?? awaiting;
    scheduleReflection(answered, db);
    return { feedback: answered, menuMessageId: input.menuMessageId };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/**
 * The latest global self-correction text for the system prompt, or null when
 * none exists yet. Read fresh per reply (like the personality).
 */
export async function getLatestSelfCorrectionPrompt(db: DrizzleDb = getDb()): Promise<string | null> {
  const latest = await getLatestCorrection(db);
  return latest?.correction.trim() ? latest.correction : null;
}

/** The sender-preferences block injected into a reply (parallel of UserContext). */
export interface PreferencesContext {
  content: string;
  /** Trace payload for the "communication preferences loaded" step. */
  data: { userId: string; version: number };
}

/**
 * Server-only: the latest communication preferences of a sender, formatted for
 * injection as a system message on a reply. Null when the user has no
 * preferences yet (nothing useful to inject).
 */
export async function getPreferencesContext(
  userId: string,
  db: DrizzleDb = getDb(),
): Promise<PreferencesContext | null> {
  const latest = await getLatestPreference(db, userId);
  if (!latest) return null;
  const [user] = await getKnownUsersByIds(db, [userId]);
  const label = user ? formatKnownUserLabel(user) : `user ${userId}`;
  const content = formatPreferencesContext({
    label,
    likes: latest.likes,
    dislikes: latest.dislikes,
  });
  if (!content) return null;
  return { content, data: { userId, version: latest.version } };
}

/** A feedback row resolved with its sender's label (dashboard). */
export interface UserFeedbackView extends UserFeedback {
  userLabel: string;
}

/** A preferences snapshot resolved with its user's label (dashboard). */
export interface CommunicationPreferenceView extends CommunicationPreference {
  userLabel: string;
}

/** An exclusion resolved with the label of whoever reported it (dashboard). */
export interface AddressingExclusionView extends AddressingExclusion {
  userLabel: string;
}

/** Everything the dashboard page shows. */
export interface SelfImprovementView {
  feedbacks: UserFeedbackView[];
  preferences: CommunicationPreferenceView[];
  correction: SelfCorrection | null;
  /** Words the analyzer must not read as the bot's name (from 👎 reports). */
  exclusions: AddressingExclusionView[];
}

/**
 * Aggregate dashboard view: feedbacks, latest preferences per user, latest
 * correction, and the addressing exclusions those feedbacks produced.
 */
export async function getSelfImprovementView(db: DrizzleDb = getDb()): Promise<SelfImprovementView> {
  const [feedbacks, preferences, correction, exclusions] = await Promise.all([
    listFeedbacks(db),
    listLatestPreferences(db),
    getLatestCorrection(db),
    listAddressingExclusions(db),
  ]);
  const userIds = [
    ...feedbacks.map((f) => f.userId),
    ...preferences.map((p) => p.userId),
    ...exclusions.flatMap((e) => (e.userId ? [e.userId] : [])),
  ];
  const users = await getKnownUsersByIds(db, userIds);
  const labels = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const labelFor = (userId: string) => labels.get(userId) ?? `user ${userId}`;
  return {
    feedbacks: feedbacks.map((f) => ({ ...f, userLabel: labelFor(f.userId) })),
    preferences: preferences.map((p) => ({ ...p, userLabel: labelFor(p.userId) })),
    correction,
    exclusions: exclusions.map((e) => ({
      ...e,
      userLabel: e.userId ? labelFor(e.userId) : "—",
    })),
  };
}

/**
 * Remove an addressing exclusion: the operator's undo when a word was excluded
 * in error, after which the analyzer may match it again. Traced like any other
 * mutation of learned state.
 */
export async function removeAddressingExclusion(
  id: string,
  db: DrizzleDb = getDb(),
): Promise<AddressingExclusion | null> {
  const trace = await startTrace({
    feature: FEEDBACK_FEATURE.id,
    action: "exclusion-delete",
    trigger: { kind: "dashboard", actor: "operator" },
    inputSummary: `remove addressing exclusion ${id}`,
  });
  try {
    const removed = await deleteAddressingExclusion(db, id);
    if (!removed) {
      await trace.skip("exclusion not found");
      return null;
    }
    await trace.event({
      type: "db",
      level: "success",
      message: `addressing exclusion removed: "${removed.term}"`,
      data: { exclusion: removed },
    });
    publishEvent(FEEDBACK_FEATURE.realtimeTopic);
    await trace.succeed({ outputSummary: `"${removed.term}" is matchable again` });
    return removed;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
