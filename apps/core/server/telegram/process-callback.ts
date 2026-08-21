import "server-only";

import type { CallbackQuery } from "@grammyjs/types";

import {
  decodeMenuCallback,
  MENU_NOT_YOURS_TOAST,
  MENU_RECORDED_TOAST,
} from "@/features/self-improvement/menu";
import {
  handleMenuPress,
  type MenuPressOutcome,
} from "@/features/self-improvement/server/service";

import type { FeedbackTransport } from "./transport";

/**
 * Transport-agnostic handler for `callback_query` updates: a press on a
 * feedback menu records the chosen option (or flips the row to awaiting a
 * free-text reply). Presses from anyone but the reactor only get a toast —
 * the group-visible menu is answerable by one user only (user decision; a
 * Telegram group message cannot be shown to a single member).
 *
 * Every outcome is answered with a toast rather than a message: an answered menu
 * deletes itself, so the popup is all the acknowledgement the chat gets.
 */

/** Outcome of one callback update, for tests/logging. */
export type ProcessCallbackOutcome =
  | MenuPressOutcome
  | { status: "ignored"; reason: "not_feedback_menu" | "no_message" };

/** Handle one `callback_query` update end to end (always answers the query). */
export async function processCallbackUpdate(
  query: Pick<CallbackQuery, "id" | "from" | "data" | "message">,
  transport: FeedbackTransport,
): Promise<ProcessCallbackOutcome> {
  const selection = query.data ? decodeMenuCallback(query.data) : null;
  if (!selection) {
    // Not one of our menus — answer anyway so the button stops spinning.
    await transport.answerCallback({ callbackQueryId: query.id }).catch(() => undefined);
    return { status: "ignored", reason: "not_feedback_menu" };
  }

  // The menu message is needed to edit it in place; Telegram omits it for
  // messages that are too old or inaccessible.
  const message = query.message;
  if (!message) {
    await transport.answerCallback({ callbackQueryId: query.id }).catch(() => undefined);
    return { status: "ignored", reason: "no_message" };
  }
  const chatId = String(message.chat.id);
  const menuMessageId = message.message_id;

  const outcome = await handleMenuPress(selection, String(query.from.id), {
    editMenu: (input) =>
      transport.editMenu({
        chatId,
        messageId: menuMessageId,
        text: input.text,
        keyboard: input.keyboard,
      }),
    // Cosmetic cleanup of an already-stored answer — a chat left with a stale
    // menu must not fail the press.
    deleteMenu: () =>
      transport.deleteMenu({ chatId, messageId: menuMessageId }).catch(() => undefined),
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
  await transport.answerCallback({ callbackQueryId: query.id, text: toast }).catch(() => undefined);
  return outcome;
}
