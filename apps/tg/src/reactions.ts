import type { ReactionTypeEmoji } from "@grammyjs/types";

import { lookupMirroredMessage } from "./core-client";
import type { TgOutbound } from "./outbound";
import { isGroupChat } from "./send";
import { updateEnvelope, type UpdatePublisher } from "./updates";

/**
 * Reacting to a message: Telegram's own emoji set, the normalization a model's
 * spelling needs, and the mirror-gated call itself.
 *
 * All of it lives here rather than in the core because all of it is Telegram:
 * the 73 emoji the Bot API accepts, the presentation-selector spelling it
 * rejects, and the rule that the bot never badges its own message. Since the
 * Phase 7 de-storing the mirror lives in the core, so the pre-check asks it
 * over the internal API and the badge is recorded via a bot-reaction event.
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
 * none. Only mechanical normalization: emoji presentation selectors (U+FE0F)
 * are stripped before matching. Nothing is guessed.
 */
export function toTelegramReactionEmoji(input: string): TelegramReactionEmoji | null {
  const stripped = input.trim().replaceAll("\u{FE0F}", "");
  return TELEGRAM_REACTION_EMOJI.find((emoji) => emoji === stripped) ?? null;
}

/** What a reaction attempt came to; a platform refusal throws instead. */
export type ReactionStatus = "ok" | "not_found" | "own_message";

export interface ReactionOutcome {
  status: ReactionStatus;
  /** Whether the mirror remembers the reaction (a failed record is cosmetic). */
  recorded: boolean;
}

/**
 * React to a message on behalf of one assistant's bot. The mirror gates the
 * platform call (v1 tool order): an id the model guessed, or the bot's own
 * message, is refused without touching Telegram. A Telegram refusal throws
 * with its own words — swallowing it would leave the model telling the chat
 * it reacted.
 */
export async function reactToMessage(input: {
  sender: TgOutbound;
  updates: UpdatePublisher;
  chatId: string;
  messageId: number;
  emoji: string | null;
  big?: boolean;
  assistantId: string | null;
}): Promise<ReactionOutcome> {
  const direct = !isGroupChat(input.chatId);
  const target = await lookupMirroredMessage({
    chatId: input.chatId,
    sourceMessageId: String(input.messageId),
    assistantId: input.assistantId,
    direct,
  });
  if (!target.found) return { status: "not_found", recorded: false };
  // `assistant` is exactly this bot's own output in the mirror — another
  // bot's message arrives as an ordinary `user` row and stays fair game.
  if (target.role === "assistant") return { status: "own_message", recorded: false };

  await input.sender.setReaction(input.chatId, input.messageId, input.emoji, {
    big: input.big ?? false,
  });

  // The reaction IS on the message, so a failed record degrades to
  // `recorded: false` rather than failing the call.
  try {
    await input.updates.publish({
      ...updateEnvelope(`${input.chatId}:${input.messageId}`),
      type: "transport.bot-reaction",
      source: "tg",
      chat: { id: input.chatId, kind: direct ? "direct" : "group" },
      assistantId: input.assistantId,
      sourceMessageId: String(input.messageId),
      emoji: input.emoji,
    });
    return { status: "ok", recorded: true };
  } catch {
    return { status: "ok", recorded: false };
  }
}
