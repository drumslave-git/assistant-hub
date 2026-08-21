import type { Message, MessageEntity, User } from "@grammyjs/types";

import type { BotIdentity } from "@/features/bot-messaging/server/addressing";

/**
 * Reusable Telegram primitives for tests. The unit tests for addressing,
 * media detection, and the messaging service all need minimal-but-well-formed
 * `User`/`Message` values; build them here instead of hand-rolling literals in
 * each file. Only the fields a test asserts on need to be passed — everything
 * else defaults sensibly.
 */

/**
 * The bot identity used across messaging tests. The display name is deliberately
 * *not* a variation of the username: addressing treats the spoken name and the
 * @handle as separate routes, so a shared string would let either one pass a test
 * meant for the other.
 */
export const BOT: BotIdentity = { id: 42, username: "MyBot", displayName: "Aria" };

/** Build a minimal Telegram `User`. Defaults to a human named `User<id>`. */
export function makeUser(id: number, overrides: Partial<User> = {}): User {
  return { id, is_bot: false, first_name: `User${id}`, ...overrides };
}

/** The {@link BOT} as a Telegram `User` (its own reply author / mention target). */
export const BOT_USER: User = makeUser(BOT.id, {
  is_bot: true,
  first_name: BOT.displayName,
  username: BOT.username,
});

/**
 * Build a minimal but well-formed Telegram `Message`. Defaults to a private
 * chat; pass `chat` to place it in a group. Loose input so reply chains can
 * nest full messages (the SDK types `reply_to_message` more narrowly).
 */
export function makeMessage(
  partial: Partial<Message> | Record<string, unknown> = {},
): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
    ...partial,
  } as Message;
}

/** A `text` message carrying a single entity (mention, command, …). */
export function messageWithEntity(text: string, entity: MessageEntity): Message {
  return makeMessage({ text, entities: [entity] });
}
