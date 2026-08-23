import type { Addressing } from "@assistant-hub/contracts";
import type { Message } from "@grammyjs/types";

/**
 * The deterministic half of addressing — whether a message is addressed to
 * the bot, as far as a pure check can tell. Ported verbatim from v1
 * (`features/bot-messaging/server/addressing.ts`): it reads Telegram wire
 * shapes (entities, mentions, commands, reply targets), which is exactly
 * why it lives in this app — the verdict crosses the contract, the wire
 * format never does. The genuinely ambiguous case (the name in another
 * alphabet or an inflected form) goes to the core's LLM analyzer via
 * `needsAnalyzer`; deliberately NO lexical pre-filter in front of it
 * (user decision, 2026-07-20).
 *
 * Rules: private chats always addressed; groups when the message @mentions
 * the bot, replies to one of its messages, is a `/command@botusername`, or
 * speaks the display name literally.
 */

/** Minimal identity the addressing check needs. */
export interface BotAddressIdentity {
  id: number;
  username: string;
  /** The bot's display name (getMe `first_name`) — the name people speak. */
  displayName: string;
}

const NOT_ADDRESSED: Addressing = { addressed: false, needsAnalyzer: false };

/**
 * Display names too generic to treat as a summons: a bot called "Bot" would
 * answer every message that mentions bots.
 */
const GENERIC_DISPLAY_NAMES = new Set(["bot", "ai", "assistant", "the", "and", "cloud"]);

/** Below this, a "name" is too short to match without constant false positives. */
const MIN_DISPLAY_NAME_LENGTH = 3;

/** Whether a display name is specific enough to be worth matching at all. */
export function displayNameMatchable(displayName: string): boolean {
  const trimmed = displayName.trim();
  if (trimmed.length < MIN_DISPLAY_NAME_LENGTH) return false;
  return !GENERIC_DISPLAY_NAMES.has(trimmed.toLowerCase());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether free text speaks the bot's display name. The name must stand as
 * its own word and must not be the tail of an @handle; boundaries are
 * `\p{L}\p{N}`-based because `\b` is ASCII-only (a Cyrillic-named bot
 * matched with `\b` would answer to substrings).
 */
export function messageNamesBot(text: string, displayName: string): boolean {
  if (!text.trim() || !displayNameMatchable(displayName)) return false;
  const name = escapeRegex(displayName.trim());
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@])${name}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

/** Telegram entity offsets are UTF-16 code units, matching JS string indexing. */
function sliceEntity(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length);
}

function messageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

function isReplyToBot(message: Message, botId: number): boolean {
  return message.reply_to_message?.from?.id === botId;
}

function hasUsernameMention(message: Message, botId: number, username: string): boolean {
  const text = messageText(message);
  if (!text) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user.id === botId) return true;
    if (entity.type === "mention") {
      const mention = sliceEntity(text, entity.offset, entity.length)
        .replace(/^@/, "")
        .toLowerCase();
      if (mention === user) return true;
    }
  }
  // Fallback for clients that omit entities: literal "@username" substring.
  return user.length > 0 && text.toLowerCase().includes(`@${user}`);
}

function hasCommandForBot(message: Message, username: string): boolean {
  const text = messageText(message);
  if (!text.trimStart().startsWith("/")) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type !== "bot_command") continue;
    const cmd = sliceEntity(text, entity.offset, entity.length);
    const at = cmd.indexOf("@");
    if (at !== -1 && cmd.slice(at + 1).toLowerCase() === user) return true;
  }
  return false;
}

/**
 * Decide as much as a pure check can; a group message that names nothing
 * recognizable but still carries text comes back `needsAnalyzer`.
 * `transcript` is the spoken text of a voice message (media slice).
 */
export function checkAddressed(
  message: Message,
  chatType: string,
  bot: BotAddressIdentity,
  transcript?: string,
): Addressing {
  if (chatType === "private") {
    return { addressed: true, source: "private", needsAnalyzer: false };
  }
  if (chatType !== "group" && chatType !== "supergroup") return NOT_ADDRESSED;
  if (!bot.id || !bot.username) return NOT_ADDRESSED;

  if (isReplyToBot(message, bot.id)) {
    return { addressed: true, source: "reply", needsAnalyzer: false };
  }
  // Command before the mention fallback: `/start@botname` carries a
  // bot_command entity whose suffix would otherwise match the loose check.
  if (hasCommandForBot(message, bot.username)) {
    return { addressed: true, source: "command", needsAnalyzer: false };
  }
  if (hasUsernameMention(message, bot.id, bot.username)) {
    return { addressed: true, source: "mention", needsAnalyzer: false };
  }

  const text = messageText(message) || transcript?.trim() || "";
  if (messageNamesBot(text, bot.displayName)) {
    return {
      addressed: true,
      source: "name",
      needsAnalyzer: false,
      reason: "display name spoken",
    };
  }
  if (text.trim() && displayNameMatchable(bot.displayName)) {
    return { addressed: false, needsAnalyzer: true };
  }
  return NOT_ADDRESSED;
}
