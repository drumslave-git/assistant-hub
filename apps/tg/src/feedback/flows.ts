import { randomUUID } from "node:crypto";

import {
  feedbackRecordedEventSchema,
  scopedRef,
  type DashboardRefreshEvent,
  type FeedbackRecordedEvent,
} from "@assistant-hub/contracts";
import { dashboardRefresh } from "@assistant-hub/service";
import type { CallbackQuery, MessageReactionUpdated, ReactionType } from "@grammyjs/types";

import type { TgDb } from "../db";
import { getMessageByTelegramId } from "../store";
import {
  MENU_AWAITING_TEXT,
  MENU_NOT_YOURS_TOAST,
  MENU_RECORDED_TOAST,
  OTHER_OPTION,
  buildMenuKeyboard,
  decodeMenuCallback,
  menuText,
  optionsForReaction,
  topicForAnswer,
  type FeedbackReaction,
  type MenuKeyboard,
  type MenuSelection,
} from "./menu";
import {
  completeFeedback,
  findAwaitingFeedbackByMenu,
  getFeedback,
  markFeedbackAwaitingText,
  setFeedbackMenuMessage,
  upsertFeedback,
  type FeedbackRecord,
} from "./store";

/**
 * The feedback-collection flows (reaction → menu → answer), tg-local since
 * the source split: the v1 `process-reaction.ts` / `process-callback.ts` /
 * `captureFeedbackReply` handlers ported onto this app's store. What the
 * core needs from a completed feedback — reflection, preference/correction
 * folding, addressing exclusions — it hears as a `feedback.recorded` bus
 * event; nothing here decides anything about the bot's behavior.
 *
 * Telegram constraint carried over: in groups `message_reaction` updates
 * are only delivered when the bot is an administrator (they arrive out of
 * the box in private chats), and the update type must be listed in the
 * poller's `allowed_updates`.
 */

/** Outbound ops the menu flows need (a grammy adapter, or a test fake). */
export interface FeedbackTransport {
  /** Post the options menu into the chat, resolving with its message id. */
  sendMenu(input: {
    chatId: string;
    text: string;
    keyboard: MenuKeyboard;
    replyToMessageId: number;
  }): Promise<{ messageId: number }>;
  /** Rewrite a previously sent menu message (`null` keyboard removes it). */
  editMenu(input: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard: MenuKeyboard | null;
  }): Promise<void>;
  /**
   * Remove a menu message once its answer is stored, so the chat keeps no
   * feedback chatter. Telegram refuses to delete messages older than 48h,
   * so callers treat a failure as cosmetic.
   */
  deleteMenu(input: { chatId: string; messageId: number }): Promise<void>;
  /** Answer a callback query (stops the button spinner; optional toast text). */
  answerCallback(input: { callbackQueryId: string; text?: string }): Promise<void>;
}

export interface FeedbackDeps {
  db: TgDb;
  /** The assistant of the receiving connection — scopes DM mirror lookups. */
  assistantId: string;
  transport: FeedbackTransport;
  /** Publish one bus event; failures surface to the caller's error handling. */
  publish: (event: FeedbackRecordedEvent | DashboardRefreshEvent) => Promise<void>;
}

/** The completed row, shaped as the bus event the core's learning jobs consume. */
function recordedEvent(feedback: FeedbackRecord): FeedbackRecordedEvent {
  return feedbackRecordedEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    // The turn correlation of the REACTED reply, so the feedback groups with
    // the trace of the reply it judges (v1 trace correlation, kept).
    correlationId: `${feedback.chatId}:${feedback.telegramMessageId}`,
    type: "feedback.recorded",
    source: "tg",
    feedback: {
      id: feedback.id,
      chatRef: scopedRef("tg", "chat", feedback.chatId),
      sourceMessageId: String(feedback.telegramMessageId),
      userRef: scopedRef("tg", "user", feedback.userId),
      reaction: feedback.reaction,
      text: feedback.feedback ?? "",
      topic: feedback.topic,
    },
  } satisfies FeedbackRecordedEvent);
}

/** Publish a completion; best-effort — the answer is stored either way. */
async function publishRecorded(deps: FeedbackDeps, feedback: FeedbackRecord): Promise<void> {
  try {
    await deps.publish(recordedEvent(feedback));
  } catch (err) {
    console.error(
      `Failed to publish feedback.recorded for ${feedback.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Emoji set of one reaction list (custom/paid reactions are not thumbs). */
function emojiSet(reactions: ReactionType[]): Set<string> {
  const set = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.type === "emoji") set.add(reaction.emoji);
  }
  return set;
}

/**
 * The thumb reaction *added* by this update, or null (reaction removals and
 * other emoji are ignored — feedback is collected only on a fresh 👍/👎).
 */
export function detectAddedThumb(
  update: Pick<MessageReactionUpdated, "old_reaction" | "new_reaction">,
): FeedbackReaction | null {
  const before = emojiSet(update.old_reaction);
  const after = emojiSet(update.new_reaction);
  if (after.has("👍") && !before.has("👍")) return "up";
  if (after.has("👎") && !before.has("👎")) return "down";
  return null;
}

/** Outcome of one reaction update, for tests/logging. */
export type ProcessReactionOutcome =
  | { status: "menu_sent"; feedback: FeedbackRecord; menuMessageId: number }
  | { status: "ignored"; reason: "not_thumb" | "no_user" | "not_bot_message" | "unknown_message" };

/**
 * Handle one `message_reaction` update end to end: a 👍/👎 added on one of
 * the bot's own replies opens (or reopens) a feedback row and posts the
 * options menu.
 */
export async function processReactionUpdate(
  update: MessageReactionUpdated,
  deps: FeedbackDeps,
): Promise<ProcessReactionOutcome> {
  // Anonymous (channel-identity) reactions carry no user — nobody to ask.
  const user = update.user;
  if (!user || user.is_bot) return { status: "ignored", reason: "no_user" };

  const reaction = detectAddedThumb(update);
  if (!reaction) return { status: "ignored", reason: "not_thumb" };

  const chatId = String(update.chat.id);
  // Only THIS bot's own replies collect feedback — a thumbs-up on a human
  // message, another assistant's reply, or a message we never mirrored is
  // silently ignored (the DM lookup is scoped to this connection's stream).
  const target = await getMessageByTelegramId(deps.db, chatId, update.message_id, deps.assistantId);
  if (!target) return { status: "ignored", reason: "unknown_message" };
  if (target.role !== "assistant") return { status: "ignored", reason: "not_bot_message" };

  const feedback = await upsertFeedback(deps.db, {
    id: randomUUID(),
    chatId,
    telegramMessageId: update.message_id,
    userId: String(user.id),
    reaction,
  });
  const sent = await deps.transport.sendMenu({
    chatId,
    text: menuText(feedback.reaction),
    keyboard: buildMenuKeyboard(feedback.reaction, feedback.id),
    replyToMessageId: update.message_id,
  });
  await setFeedbackMenuMessage(deps.db, feedback.id, sent.messageId);
  // A fresh pending row — the dashboard's feedback listing shows it live.
  await deps.publish(dashboardRefresh("tg", ["feedback"])).catch(() => undefined);
  return { status: "menu_sent", feedback, menuMessageId: sent.messageId };
}

/** Outcome of a menu press, mapped by the caller to callback-query answers. */
export type MenuPressOutcome =
  | { status: "recorded"; feedback: FeedbackRecord }
  | { status: "awaiting_text"; feedback: FeedbackRecord }
  | { status: "not_yours" }
  | { status: "unknown" };

/**
 * Handle a press on a feedback menu. Only the reactor may answer (a
 * Telegram group message cannot be shown to a single member, so the
 * group-visible menu is answerable by one user only — user decision); a
 * predefined option completes the row, "Other" flips it to awaiting a
 * reply.
 */
export async function handleMenuPress(
  selection: MenuSelection,
  presserUserId: string,
  deps: FeedbackDeps,
  menu: { chatId: string; menuMessageId: number },
): Promise<MenuPressOutcome> {
  const feedback = await getFeedback(deps.db, selection.feedbackId);
  if (!feedback || feedback.status === "completed") return { status: "unknown" };
  if (feedback.userId !== presserUserId) return { status: "not_yours" };

  if (selection.option === OTHER_OPTION) {
    await markFeedbackAwaitingText(deps.db, feedback.id);
    await deps.transport.editMenu({
      chatId: menu.chatId,
      messageId: menu.menuMessageId,
      text: MENU_AWAITING_TEXT,
      keyboard: null,
    });
    return { status: "awaiting_text", feedback: { ...feedback, status: "awaiting_text" } };
  }

  const options = optionsForReaction(feedback.reaction);
  const chosen = options[selection.option];
  if (!chosen) return { status: "unknown" };
  const updated = await completeFeedback(deps.db, feedback.id, chosen, topicForAnswer(chosen));
  const answered = updated ?? feedback;
  // The answer is stored; the menu has done its job and goes away (the press
  // is acknowledged by the toast, not by a message). Cosmetic cleanup — a
  // chat left with a stale menu must not fail the press.
  await deps.transport
    .deleteMenu({ chatId: menu.chatId, messageId: menu.menuMessageId })
    .catch(() => undefined);
  await publishRecorded(deps, answered);
  return { status: "recorded", feedback: answered };
}

/** Outcome of one callback update, for tests/logging. */
export type ProcessCallbackOutcome =
  | MenuPressOutcome
  | { status: "ignored"; reason: "not_feedback_menu" | "no_message" };

/**
 * Handle one `callback_query` update end to end (always answers the query —
 * every outcome is a toast rather than a message: an answered menu deletes
 * itself, so the popup is all the acknowledgement the chat gets).
 */
export async function processCallbackUpdate(
  query: Pick<CallbackQuery, "id" | "from" | "data" | "message">,
  deps: FeedbackDeps,
): Promise<ProcessCallbackOutcome> {
  const selection = query.data ? decodeMenuCallback(query.data) : null;
  if (!selection) {
    // Not one of our menus — answer anyway so the button stops spinning.
    await deps.transport.answerCallback({ callbackQueryId: query.id }).catch(() => undefined);
    return { status: "ignored", reason: "not_feedback_menu" };
  }

  // The menu message is needed to edit it in place; Telegram omits it for
  // messages that are too old or inaccessible.
  const message = query.message;
  if (!message) {
    await deps.transport.answerCallback({ callbackQueryId: query.id }).catch(() => undefined);
    return { status: "ignored", reason: "no_message" };
  }

  const outcome = await handleMenuPress(selection, String(query.from.id), deps, {
    chatId: String(message.chat.id),
    menuMessageId: message.message_id,
  });

  const toast =
    outcome.status === "not_yours"
      ? MENU_NOT_YOURS_TOAST
      : outcome.status === "unknown"
        ? "This menu is no longer active."
        : outcome.status === "recorded"
          ? MENU_RECORDED_TOAST
          : // `awaiting_text` — the menu message itself now carries the instruction.
            undefined;
  await deps.transport
    .answerCallback({ callbackQueryId: query.id, ...(toast ? { text: toast } : {}) })
    .catch(() => undefined);
  return outcome;
}

/**
 * Try to capture an incoming message as the free-text answer to an
 * `awaiting_text` feedback: the message must reply to the menu message and
 * come from the reactor. Returns null when the message is not a feedback
 * answer — the caller then processes it as a normal turn.
 *
 * Nothing is sent back: this flow has no callback query to toast, and the
 * user's own reply is already in the chat, so the answer is acknowledged by
 * the menu message disappearing (deleted here, best-effort).
 */
export async function captureFeedbackReply(
  input: { chatId: string; menuMessageId: number; userId: string; text: string },
  deps: FeedbackDeps,
): Promise<FeedbackRecord | null> {
  if (!input.text.trim()) return null;
  const awaiting = await findAwaitingFeedbackByMenu(
    deps.db,
    input.chatId,
    input.menuMessageId,
    input.userId,
  );
  if (!awaiting) return null;

  const updated = await completeFeedback(deps.db, awaiting.id, input.text);
  const answered = updated ?? awaiting;
  await deps.transport
    .deleteMenu({ chatId: input.chatId, messageId: input.menuMessageId })
    .catch(() => undefined);
  await publishRecorded(deps, answered);
  return answered;
}
