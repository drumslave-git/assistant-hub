import type { ReactionTypeEmoji } from "@grammyjs/types";

import type { TgDb } from "./db";
import type { TgOutbound } from "./outbound";
import { getMessageByTelegramId, recordBotReaction } from "./store";

/**
 * Reacting to a message: Telegram's own emoji set, the normalization a model's
 * spelling needs, and the mirror-gated call itself.
 *
 * All of it lives here rather than in the core because all of it is Telegram:
 * the 73 emoji the Bot API accepts, the presentation-selector spelling it
 * rejects, and the rule that the bot never badges its own message. The core
 * asks for a reaction through this app's MCP server and relays whatever comes
 * back.
 */

/** Exactly the reactions Telegram's Bot API accepts. */
export const TELEGRAM_REACTION_EMOJI = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔",
  "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄",
  "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
  "😡",
] as const satisfies readonly ReactionTypeEmoji["emoji"][];

export type TelegramReactionEmoji = (typeof TELEGRAM_REACTION_EMOJI)[number];

/**
 * The canonical reaction emoji matching `input`, or null when Telegram has
 * none.
 *
 * Only mechanical normalization: emoji presentation selectors (U+FE0F) are
 * stripped before matching, because a client (or a model) writes the heart as
 * `U+2764 U+FE0F` while the Bot API names it `U+2764` and rejects the other
 * spelling. Nothing is guessed: an emoji outside the set stays unmatched.
 */
export function toTelegramReactionEmoji(input: string): TelegramReactionEmoji | null {
  const stripped = input.trim().replaceAll("\u{FE0F}", "");
  return TELEGRAM_REACTION_EMOJI.find((emoji) => emoji === stripped) ?? null;
}

/** What a reaction attempt came to; a platform refusal throws instead. */
export type ReactionStatus = "ok" | "not_found" | "own_message";

export interface ReactionOutcome {
  status: ReactionStatus;
  /** Whether the mirror remembers the reaction (a failed write is cosmetic). */
  recorded: boolean;
}

/**
 * React to a message on behalf of one assistant's bot. The mirror gates the
 * platform call (v1 tool order): an id the model guessed, or the bot's own
 * message, is refused without touching Telegram. A Telegram refusal (a
 * chat-restricted emoji, a message too old) throws with its own words —
 * swallowing it would leave the model telling the chat it reacted.
 */
export async function reactToMessage(input: {
  db: TgDb;
  sender: TgOutbound;
  chatId: string;
  messageId: number;
  emoji: string | null;
  big?: boolean;
  assistantId: string | null;
}): Promise<ReactionOutcome> {
  const target = await getMessageByTelegramId(
    input.db,
    input.chatId,
    input.messageId,
    input.assistantId,
  );
  if (!target) return { status: "not_found", recorded: false };
  // `assistant` is exactly this bot's own output in the mirror — another
  // bot's message arrives as an ordinary `user` row and stays fair game.
  if (target.role === "assistant") return { status: "own_message", recorded: false };

  await input.sender.setReaction(input.chatId, input.messageId, input.emoji, {
    big: input.big ?? false,
  });

  // The reaction IS on the message, so a failed mirror write degrades to
  // `recorded: false` rather than failing the call (v1).
  try {
    await recordBotReaction(input.db, {
      chatId: input.chatId,
      telegramMessageId: input.messageId,
      emoji: input.emoji,
      assistantId: input.assistantId,
    });
    return { status: "ok", recorded: true };
  } catch {
    return { status: "ok", recorded: false };
  }
}
