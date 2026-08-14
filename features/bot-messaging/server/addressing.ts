import type { Message } from "@grammyjs/types";

/**
 * Whether a message is addressed to the bot. Pure and deterministic — no network
 * calls — so it is fully unit-testable and cheap to run on every update.
 *
 * Rules (recreated from the MVP's deterministic checks):
 * - Private chats: always addressed.
 * - Groups/supergroups: addressed when the message @mentions the bot (by
 *   username or a `text_mention` entity), replies to one of the bot's messages,
 *   is a `/command@botusername` targeting the bot, or speaks the bot's display
 *   name literally.
 *
 * People do not only address a bot by its handle — they call it by name, and in
 * a multilingual chat they write that name in their own alphabet or decline it
 * ("Ари, привет"). A literal match cannot see either, so when these rules find
 * nothing but the message could still be naming the bot, the result is
 * *undecided* ({@link AddressResult.needsAnalyzer}) and the caller settles it
 * with one LLM call — see `address-analyzer.ts`. Keeping that split here means
 * the cheap checks stay pure and only a genuinely ambiguous message costs a
 * completion.
 *
 * Deliberately NO cheap "name-shaped" pre-filter in front of the analyzer: one
 * was built and reverted (user decision, 2026-07-20) — any lexical gate is
 * weaker than the LLM at spotting the name in unfamiliar spellings, and a
 * missed summons costs more than the analyzer calls saved. Every undecided
 * group message goes to the analyzer.
 */

export type AddressSource =
  | "private"
  | "mention"
  | "reply"
  | "command"
  /** The display name, spelled exactly as configured. */
  | "name"
  /** The display name in another alphabet or an inflected form (LLM verdict). */
  | "analyzer"
  /**
   * Nobody addressed the bot: the turn was opened by a standing `always` chat
   * task that matched the message (see `features/tasks/server/matcher.ts`).
   * Never produced by the checks in this module — the caller sets it after the
   * addressing verdict has already come back negative.
   */
  | "task";

export interface AddressResult {
  addressed: boolean;
  source?: AddressSource;
  /**
   * True when nothing deterministic matched but the message is still a candidate
   * (a group message with text, and a bot display name worth looking for). The
   * caller runs the LLM analyzer; nobody else should treat this as "addressed".
   */
  needsAnalyzer?: boolean;
  /** Human explanation of the verdict, when there is one to give. */
  reason?: string;
  /**
   * The word the analyzer took for the display name, when it cited one — recorded
   * on the trace so a later "wasn't talking to you" report knows exactly which
   * word to exclude, rather than parsing it back out of {@link reason}. Present
   * on analyzer verdicts only, and on rejected ones too (a citation that failed
   * the verifier is still what the model saw).
   */
  matchedText?: string;
}

/** Minimal identity the addressing check needs. */
export interface BotIdentity {
  id: number;
  username: string;
  /**
   * The bot's Telegram display name (getMe `first_name`) — the name people
   * actually speak, as opposed to the `@username` they type.
   */
  displayName: string;
}

const NOT_ADDRESSED: AddressResult = { addressed: false };

/**
 * Display names too generic to treat as a summons: a bot called "Bot" would
 * answer every message that mentions bots, and every one of those misses would
 * also cost an analyzer call.
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
 * Whether free text speaks the bot's display name (as opposed to @mentioning it).
 *
 * The name must stand as its own word and must not be the tail of an @handle
 * (`@AriaFanClub` is not a summons). The boundaries are `\p{L}\p{N}`-based rather
 * than `\b`, because `\w` is ASCII-only: a Cyrillic-named bot matched with `\b`
 * treats every Cyrillic letter as a word boundary, so a bot named "Бот" would
 * answer to "работа".
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

/** A message's user text — its body, or the caption when it carries media. */
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
      const mention = sliceEntity(text, entity.offset, entity.length).replace(/^@/, "").toLowerCase();
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
 * Decide whether the bot should treat this message as addressed to it, as far as
 * a pure check can. A group message that names nothing recognizable but still
 * carries text comes back undecided (`needsAnalyzer`) rather than not-addressed.
 *
 * `transcript` is the spoken text of a voice message (produced before this check
 * runs): a voice message has no `text`/`caption`/entities, so the name check and
 * the analyzer gate read the transcript instead — "hey <botname>, …" spoken
 * aloud is as much a summons as typed.
 */
export function checkAddressed(
  message: Message,
  chatType: string,
  bot: BotIdentity,
  transcript?: string,
): AddressResult {
  if (chatType === "private") return { addressed: true, source: "private" };
  if (chatType !== "group" && chatType !== "supergroup") return NOT_ADDRESSED;
  if (!bot.id || !bot.username) return NOT_ADDRESSED;

  if (isReplyToBot(message, bot.id)) return { addressed: true, source: "reply" };
  // Command before the mention fallback: `/start@botname` carries a bot_command
  // entity, and its `@botname` suffix would otherwise match the loose mention check.
  if (hasCommandForBot(message, bot.username)) return { addressed: true, source: "command" };
  if (hasUsernameMention(message, bot.id, bot.username)) return { addressed: true, source: "mention" };

  const text = messageText(message) || transcript?.trim() || "";
  if (messageNamesBot(text, bot.displayName)) {
    return { addressed: true, source: "name", reason: "display name spoken" };
  }
  // Undecided rather than silent: the name may still be here transliterated or
  // declined, which only the analyzer can see. Media with no caption gives it
  // nothing to read, and an unmatchable display name gives it nothing to find.
  if (text.trim() && displayNameMatchable(bot.displayName)) {
    return { addressed: false, needsAnalyzer: true };
  }
  return NOT_ADDRESSED;
}
