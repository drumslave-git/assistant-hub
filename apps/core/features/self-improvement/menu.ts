import { optionsForReaction, OTHER_OPTION_LABEL } from "./options";
import type { FeedbackReaction } from "./types";

/**
 * Feedback menu building + callback-data codec. Pure and transport-agnostic —
 * the keyboard is a plain grid the Telegram adapter converts to an
 * `InlineKeyboard`, so the flows and tests never touch grammy types.
 */

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
export function encodeMenuCallback(feedbackId: string, option: number | typeof OTHER_OPTION): string {
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
  rows.push([{ text: OTHER_OPTION_LABEL, callbackData: encodeMenuCallback(feedbackId, OTHER_OPTION) }]);
  return rows;
}

/**
 * Toast shown to the reactor once their answer is stored. A confirmation
 * *message* would be chat noise (user decision) — the menu message is deleted
 * instead and this transient popup is the only acknowledgement. Telegram only
 * offers a toast in answer to a button press, so the free-text flow, which has
 * no callback query to answer, is acknowledged by the menu simply disappearing.
 */
export const MENU_RECORDED_TOAST = "Thanks — noted.";

/** Instruction the menu is edited to after "Other" is tapped. */
export const MENU_AWAITING_TEXT =
  "Reply to this message with your feedback (your own words).";

/** Toast shown to a non-reactor who presses the menu. */
export const MENU_NOT_YOURS_TOAST = "This menu is for the person who reacted.";
