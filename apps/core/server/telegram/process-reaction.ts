import "server-only";

import type { MessageReactionUpdated, ReactionType } from "@grammyjs/types";

import {
  handleFeedbackReaction,
  type ReactionOutcome,
} from "@/features/self-improvement/server/service";
import type { FeedbackReaction } from "@/features/self-improvement/types";

import type { FeedbackTransport } from "./transport";

/**
 * Transport-agnostic handler for `message_reaction` updates: a 👍/👎 added on
 * one of the bot's own replies opens a feedback row and posts the options menu.
 *
 * Telegram constraint: in groups these updates are only delivered when the bot
 * is an administrator (they arrive out of the box in private chats), and
 * `message_reaction` must be listed in the poller's `allowed_updates`.
 */

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
 * other emoji are ignored — v1 collects feedback only on a fresh 👍/👎).
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
  | ReactionOutcome
  | { status: "ignored"; reason: "not_thumb" | "no_user" };

/** Handle one `message_reaction` update end to end. */
export async function processReactionUpdate(
  update: MessageReactionUpdated,
  transport: FeedbackTransport,
): Promise<ProcessReactionOutcome> {
  // Anonymous (channel-identity) reactions carry no user — nobody to ask.
  const user = update.user;
  if (!user || user.is_bot) return { status: "ignored", reason: "no_user" };

  const reaction = detectAddedThumb(update);
  if (!reaction) return { status: "ignored", reason: "not_thumb" };

  const chatId = String(update.chat.id);
  return handleFeedbackReaction(
    {
      chatId,
      telegramMessageId: update.message_id,
      userId: String(user.id),
      reaction,
    },
    {
      sendMenu: (input) =>
        transport.sendMenu({
          chatId,
          text: input.text,
          keyboard: input.keyboard,
          replyToMessageId: input.replyToMessageId,
        }),
    },
  );
}
