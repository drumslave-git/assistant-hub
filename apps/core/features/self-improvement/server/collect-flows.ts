import "server-only";

import { randomUUID } from "node:crypto";

import {
  feedbackRecordedEventSchema,
  scopedRef,
  type FeedbackRecordedEvent,
  type SourceId,
  type TransportReactionEvent,
} from "@assistant-hub-swarm/contracts";

import { publishBusEvent } from "@/server/bus/publisher";
import { publishEvent } from "@/server/realtime/hub";
import {
  completeSourceFeedback,
  findAwaitingSourceFeedbackByMenu,
  getSourceFeedback,
  markSourceFeedbackAwaitingText,
  setSourceFeedbackMenuMessage,
  upsertSourceFeedback,
  type SourceFeedbackRecord,
} from "@/server/source-store/feedbacks";
import { getSourceMessage } from "@/server/source-store/repository";

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
  type MenuKeyboard,
  type MenuSelection,
} from "./collect-menu";

/**
 * The feedback-collection flows (reaction → menu → answer), core-owned since
 * the Phase 7 de-storing: the transport forwards reaction updates and menu
 * presses and serves the menu sends; the state machine and its rows live
 * here with the conversation store. What the learning jobs need from a
 * completed feedback still arrives as a `feedback.recorded` bus event —
 * published by the core and consumed by its own events consumer, so the
 * learning half did not move at all.
 *
 * Platform constraint carried over: in telegram groups `message_reaction`
 * updates are only delivered when the bot is an administrator.
 */

/** Menu operations on the owning transport (an HTTP client, or a test fake). */
export interface CollectTransport {
  /** Post the options menu into the chat, resolving with its message id. */
  sendMenu(input: {
    chatId: string;
    assistantId: string;
    text: string;
    keyboard: MenuKeyboard;
    replyToSourceMessageId: string;
  }): Promise<{ sourceMessageId: string }>;
  /** Rewrite a previously sent menu message (`null` keyboard removes it). */
  editMenu(input: {
    chatId: string;
    assistantId: string;
    sourceMessageId: string;
    text: string;
    keyboard: MenuKeyboard | null;
  }): Promise<void>;
  /**
   * Remove a menu message once its answer is stored, so the chat keeps no
   * feedback chatter. Platform refusals (too old) are cosmetic.
   */
  deleteMenu(input: {
    chatId: string;
    assistantId: string;
    sourceMessageId: string;
  }): Promise<void>;
}

export interface CollectDeps {
  source: SourceId;
  /** The receiving connection's assistant — its bot serves the menus. */
  assistantId: string;
  transport: CollectTransport;
}

/** The completed row, shaped as the bus event the learning jobs consume. */
function recordedEvent(feedback: SourceFeedbackRecord): FeedbackRecordedEvent {
  return feedbackRecordedEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    // The turn correlation of the REACTED reply, so the feedback groups with
    // the trace of the reply it judges.
    correlationId: `${feedback.chatId}:${feedback.sourceMessageId}`,
    type: "feedback.recorded",
    source: feedback.source,
    feedback: {
      id: feedback.id,
      chatRef: scopedRef(feedback.source, "chat", feedback.chatId),
      sourceMessageId: feedback.sourceMessageId,
      userRef: scopedRef(feedback.source, "user", feedback.userId),
      reaction: feedback.reaction,
      text: feedback.feedback ?? "",
      topic: feedback.topic,
    },
  } satisfies FeedbackRecordedEvent);
}

/** Publish a completion; best-effort — the answer is stored either way. */
async function publishRecorded(feedback: SourceFeedbackRecord): Promise<void> {
  try {
    await publishBusEvent(recordedEvent(feedback));
  } catch (err) {
    console.error(
      `Failed to publish feedback.recorded for ${feedback.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Outcome of one reaction update, for traces/tests. */
export type ProcessReactionOutcome =
  | { status: "menu_sent"; feedback: SourceFeedbackRecord; menuSourceMessageId: string }
  | { status: "ignored"; reason: "not_bot_message" | "unknown_message" };

/**
 * Handle one forwarded reaction end to end: a 👍/👎 added on one of the
 * receiving bot's own replies opens (or reopens) a feedback row and posts
 * the options menu through the transport.
 */
export async function processReactionUpdate(
  event: TransportReactionEvent,
  deps: CollectDeps,
): Promise<ProcessReactionOutcome> {
  const chatId = event.chat.id;
  // Only an assistant's own reply collects feedback — a thumbs-up on a human
  // message or a message never mirrored is silently ignored (the DM lookup is
  // scoped to the receiving connection's stream).
  const target = await getSourceMessage(
    {
      source: deps.source,
      chatId,
      assistantId: deps.assistantId,
      direct: event.chat.kind === "direct",
    },
    event.sourceMessageId,
  );
  if (!target) return { status: "ignored", reason: "unknown_message" };
  if (target.role !== "assistant") return { status: "ignored", reason: "not_bot_message" };
  // The AUTHOR's bot serves the menu — a rating of Anna's reply should be
  // asked about by Anna, whichever admin bot happened to receive the update.
  const servingAssistantId = target.assistantId ?? deps.assistantId;

  const feedback = await upsertSourceFeedback({
    id: randomUUID(),
    source: deps.source,
    chatId,
    sourceMessageId: event.sourceMessageId,
    userId: event.user.userId,
    reaction: event.reaction,
  });
  const sent = await deps.transport.sendMenu({
    chatId,
    assistantId: servingAssistantId,
    text: menuText(feedback.reaction),
    keyboard: buildMenuKeyboard(feedback.reaction, feedback.id),
    replyToSourceMessageId: event.sourceMessageId,
  });
  await setSourceFeedbackMenuMessage(feedback.id, sent.sourceMessageId);
  // A fresh pending row — the dashboard's feedback listing shows it live.
  publishEvent("feedback");
  return { status: "menu_sent", feedback, menuSourceMessageId: sent.sourceMessageId };
}

/** Outcome of a menu press, mapped by the callback route to a toast. */
export type MenuPressOutcome =
  | { status: "recorded"; feedback: SourceFeedbackRecord }
  | { status: "awaiting_text"; feedback: SourceFeedbackRecord }
  | { status: "not_yours" }
  | { status: "unknown" };

/**
 * Handle a press on a feedback menu. Only the reactor may answer; a
 * predefined option completes the row, "Other" flips it to awaiting a reply.
 */
export async function handleMenuPress(
  selection: MenuSelection,
  presserUserId: string,
  deps: CollectDeps,
  menu: { chatId: string; menuSourceMessageId: string },
): Promise<MenuPressOutcome> {
  const feedback = await getSourceFeedback(selection.feedbackId);
  if (!feedback || feedback.status === "completed") return { status: "unknown" };
  if (feedback.userId !== presserUserId) return { status: "not_yours" };

  if (selection.option === OTHER_OPTION) {
    await markSourceFeedbackAwaitingText(feedback.id);
    await deps.transport.editMenu({
      chatId: menu.chatId,
      assistantId: deps.assistantId,
      sourceMessageId: menu.menuSourceMessageId,
      text: MENU_AWAITING_TEXT,
      keyboard: null,
    });
    return { status: "awaiting_text", feedback: { ...feedback, status: "awaiting_text" } };
  }

  const options = optionsForReaction(feedback.reaction);
  const chosen = options[selection.option];
  if (!chosen) return { status: "unknown" };
  const updated = await completeSourceFeedback(feedback.id, chosen, topicForAnswer(chosen));
  const answered = updated ?? feedback;
  // The answer is stored; the menu has done its job and goes away (the press
  // is acknowledged by the toast, not by a message). Cosmetic cleanup.
  await deps.transport
    .deleteMenu({
      chatId: menu.chatId,
      assistantId: deps.assistantId,
      sourceMessageId: menu.menuSourceMessageId,
    })
    .catch(() => undefined);
  await publishRecorded(answered);
  publishEvent("feedback");
  return { status: "recorded", feedback: answered };
}

/** The toast a press outcome earns (null → the menu's own edit is the answer). */
export function menuPressToast(outcome: MenuPressOutcome): string | null {
  switch (outcome.status) {
    case "not_yours":
      return MENU_NOT_YOURS_TOAST;
    case "unknown":
      return "This menu is no longer active.";
    case "recorded":
      return MENU_RECORDED_TOAST;
    case "awaiting_text":
      return null;
  }
}

/**
 * Handle a forwarded menu press end to end: decode the callback payload, run
 * the press, answer with the toast the transport relays. A payload that is
 * not a feedback menu's earns a null toast (the transport still answers the
 * query so the button stops spinning).
 */
export async function processCallbackPress(
  input: { data: string; presserUserId: string; chatId: string; menuSourceMessageId: string },
  deps: CollectDeps,
): Promise<{ outcome: MenuPressOutcome | { status: "ignored" }; toast: string | null }> {
  const selection = decodeMenuCallback(input.data);
  if (!selection) return { outcome: { status: "ignored" }, toast: null };
  const outcome = await handleMenuPress(selection, input.presserUserId, deps, {
    chatId: input.chatId,
    menuSourceMessageId: input.menuSourceMessageId,
  });
  return { outcome, toast: menuPressToast(outcome) };
}

/**
 * Try to capture an incoming message as the free-text answer to an
 * `awaiting_text` feedback: the message must reply to the menu message and
 * come from the reactor. Returns null when the message is not a feedback
 * answer — the ingest then processes it as a normal turn.
 */
export async function captureFeedbackReply(
  input: {
    chatId: string;
    menuSourceMessageId: string;
    userId: string;
    text: string;
  },
  deps: CollectDeps,
): Promise<SourceFeedbackRecord | null> {
  if (!input.text.trim()) return null;
  const awaiting = await findAwaitingSourceFeedbackByMenu(
    deps.source,
    input.chatId,
    input.menuSourceMessageId,
    input.userId,
  );
  if (!awaiting) return null;

  const updated = await completeSourceFeedback(awaiting.id, input.text);
  const answered = updated ?? awaiting;
  await deps.transport
    .deleteMenu({
      chatId: input.chatId,
      assistantId: deps.assistantId,
      sourceMessageId: input.menuSourceMessageId,
    })
    .catch(() => undefined);
  await publishRecorded(answered);
  publishEvent("feedback");
  return answered;
}
