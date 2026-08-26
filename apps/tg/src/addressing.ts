import type { Addressing } from "@assistant-hub/contracts";
import type { Message } from "@grammyjs/types";

/**
 * The STRUCTURAL half of addressing — whether the Telegram wire shape alone
 * says the message targets this bot (entities, mentions, commands, reply
 * targets). That is exactly why it lives in this app: the verdict crosses
 * the contract, the wire format never does.
 *
 * The NAME half moved to the core (user decision, 2026-08-24): people
 * summon the ASSISTANT by its name — which lives in the core's store and
 * can be renamed there any time — never by the bot account's profile name.
 * A group message this check cannot decide comes back `needsAnalyzer`, and
 * the core runs its own deterministic name check before the LLM analyzer.
 *
 * Rules here: private chats always addressed; groups when the message
 * @mentions the bot, replies to one of its messages, or is a
 * `/command@botusername`.
 */

/** Minimal identity the structural check needs (the bot ACCOUNT's). */
export interface BotAddressIdentity {
  id: number;
  username: string;
}

const NOT_ADDRESSED: Addressing = { addressed: false, needsAnalyzer: false };

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

/** Literal `@username` in the text — the entity-free half of the check. */
function textMentionsUsername(text: string, username: string): boolean {
  const user = username.toLowerCase();
  return user.length > 0 && text.toLowerCase().includes(`@${user}`);
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
  return textMentionsUsername(text, user);
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
 * Decide as much as the wire shape can; a group message that carries text
 * but targets nothing structurally comes back `needsAnalyzer` — the core
 * runs the name check (against the assistant's name) and, behind it, the
 * LLM analyzer. `transcript` is the spoken text of a voice message.
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
  if (text.trim()) {
    return { addressed: false, needsAnalyzer: true };
  }
  return NOT_ADDRESSED;
}

/**
 * The same structural verdict for a message the cross-feed hands to another
 * assistant. It never came off the wire for THIS bot, so there are no
 * entities to read: what remains is whether the author answered one of this
 * assistant's own messages, and whether the text spells its @username.
 * Everything else is undecided — the core runs the name check against the
 * assistant's name and, behind it, the analyzer.
 */
export function checkCrossFedAddressed(input: {
  /** The authoring assistant's delivered text. */
  text: string;
  /** The receiving connection's @username (no leading `@`). */
  botUsername: string;
  /** True when the author replied to a message this assistant wrote. */
  repliesToOwnMessage: boolean;
}): Addressing {
  if (input.repliesToOwnMessage) {
    return { addressed: true, source: "reply", needsAnalyzer: false };
  }
  if (input.botUsername && textMentionsUsername(input.text, input.botUsername)) {
    return { addressed: true, source: "mention", needsAnalyzer: false };
  }
  if (input.text.trim()) return { addressed: false, needsAnalyzer: true };
  return NOT_ADDRESSED;
}
