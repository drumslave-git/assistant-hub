/**
 * Feedback menu options, building, and callback-data codec — the v1
 * `features/self-improvement/{options,menu}.ts` ported verbatim with the
 * source split (the flows are Telegram interactions, so they live with the
 * source; the distilled outputs — preferences, corrections — stay core).
 * Pure and transport-agnostic: the keyboard is a plain grid the grammy
 * adapter converts to an `InlineKeyboard`.
 */

/** `up` (👍) or `down` (👎). */
export type FeedbackReaction = "up" | "down";

/** `quality` feeds the core's reflection/folds; `addressing` files an exclusion. */
export type FeedbackTopic = "quality" | "addressing";

/**
 * Predefined feedback menu options (user decision, 2026-07-14). Five per
 * reaction plus a free-text "Other". Code constants — the stored feedback is
 * the option's text, so renaming an option later does not corrupt stored
 * rows. Options are only ever *appended*: the menu's `callback_data` carries
 * the option's index, so reordering the list would make an in-flight menu
 * resolve to a different answer than the one its button showed.
 */
export const LIKE_OPTIONS = [
  "Helpful & accurate",
  "Right tone/personality",
  "Good length & format",
  "Funny/entertaining",
  "Understood the context",
] as const;

/**
 * The complaint that the bot should not have replied at all: it read someone
 * else's name as its own and joined a conversation it was not part of.
 * Unlike every other option this one is not about the reply's *content* —
 * the core, on consuming the recorded event, files the mis-triggering word
 * as an addressing exclusion instead of reflecting on reply quality.
 */
export const NOT_ADDRESSED_OPTION = "Wasn't talking to you";

export const DISLIKE_OPTIONS = [
  "Inaccurate or wrong",
  "Wrong tone",
  "Too long or rambling",
  "Missed the point/context",
  "Generic or boring",
  NOT_ADDRESSED_OPTION,
] as const;

/** Label of the free-text option button. */
export const OTHER_OPTION_LABEL = "Other — write your own";

/** The predefined option list for a reaction. */
export function optionsForReaction(reaction: FeedbackReaction): readonly string[] {
  return reaction === "up" ? LIKE_OPTIONS : DISLIKE_OPTIONS;
}

/** The topic an answer belongs to, derived from the answer itself. */
export function topicForAnswer(answer: string): FeedbackTopic {
  return answer.trim() === NOT_ADDRESSED_OPTION ? "addressing" : "quality";
}

/** One inline button: label + the `callback_data` sent back when pressed. */
export interface MenuButton {
  text: string;
  callbackData: string;
}

/** Rows of buttons (Telegram inline-keyboard shape). */
export type MenuKeyboard = MenuButton[][];

/** The "Other" selection, encoded as a non-numeric option token. */
export const OTHER_OPTION = "other" as const;

/** A parsed menu press: a predefined option index, or the free-text "Other". */
export type MenuSelection = { feedbackId: string; option: number | typeof OTHER_OPTION };

/**
 * Callback-data prefix for feedback menus. Telegram caps `callback_data` at
 * 64 bytes; `fb:<36-char uuid>:<token>` stays well under it.
 */
const CALLBACK_PREFIX = "fb";

/** Encode a menu button's callback data. */
export function encodeMenuCallback(
  feedbackId: string,
  option: number | typeof OTHER_OPTION,
): string {
  return `${CALLBACK_PREFIX}:${feedbackId}:${option}`;
}

/** Decode callback data, or null when it is not a feedback-menu press. */
export function decodeMenuCallback(data: string): MenuSelection | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, feedbackId, token] = parts;
  if (!feedbackId) return null;
  if (token === OTHER_OPTION) return { feedbackId, option: OTHER_OPTION };
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0) return null;
  return { feedbackId, option: index };
}

/** The question shown above the option buttons. */
export function menuText(reaction: FeedbackReaction): string {
  return reaction === "up"
    ? "Thanks for the 👍! What did you like about this reply?"
    : "Sorry about that 👎 — what went wrong with this reply?";
}

/** Build the menu keyboard: one predefined option per row, then "Other". */
export function buildMenuKeyboard(reaction: FeedbackReaction, feedbackId: string): MenuKeyboard {
  const rows: MenuKeyboard = optionsForReaction(reaction).map((label, index) => [
    { text: label, callbackData: encodeMenuCallback(feedbackId, index) },
  ]);
  rows.push([
    { text: OTHER_OPTION_LABEL, callbackData: encodeMenuCallback(feedbackId, OTHER_OPTION) },
  ]);
  return rows;
}

/**
 * Toast shown to the reactor once their answer is stored. A confirmation
 * *message* would be chat noise (user decision) — the menu message is
 * deleted instead and this transient popup is the only acknowledgement.
 * Telegram only offers a toast in answer to a button press, so the
 * free-text flow, which has no callback query to answer, is acknowledged by
 * the menu simply disappearing.
 */
export const MENU_RECORDED_TOAST = "Thanks — noted.";

/** Instruction the menu is edited to after "Other" is tapped. */
export const MENU_AWAITING_TEXT = "Reply to this message with your feedback (your own words).";

/** Toast shown to a non-reactor who presses the menu. */
export const MENU_NOT_YOURS_TOAST = "This menu is for the person who reacted.";
