import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import { checkAddressed, displayNameMatchable, messageNamesBot } from "./addressing";

const BOT = { id: 999, username: "fixture_bot", displayName: "Aria" };

function msg(input: Partial<Message> & { text?: string }): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1, type: "supergroup", title: "G" },
    from: { id: 5, is_bot: false, first_name: "A" },
    ...input,
  } as Message;
}

describe("checkAddressed (v1 port)", () => {
  it("private chats are always addressed", () => {
    expect(
      checkAddressed(msg({ chat: { id: 5, type: "private", first_name: "A" } as Message["chat"] }), "private", BOT),
    ).toMatchObject({ addressed: true, source: "private" });
  });

  it("a reply to the bot's message is addressed", () => {
    const message = msg({
      text: "yes",
      reply_to_message: {
        message_id: 2,
        date: 0,
        chat: { id: -1, type: "supergroup", title: "G" },
        from: { id: BOT.id, is_bot: true, first_name: "Aria" },
      } as Message["reply_to_message"],
    });
    expect(checkAddressed(message, "supergroup", BOT)).toMatchObject({
      addressed: true,
      source: "reply",
    });
  });

  it("an @mention entity addresses the bot", () => {
    const text = "hey @fixture_bot do it";
    const message = msg({
      text,
      entities: [{ type: "mention", offset: 4, length: 12 }],
    });
    expect(checkAddressed(message, "supergroup", BOT)).toMatchObject({
      addressed: true,
      source: "mention",
    });
  });

  it("speaking the display name addresses the bot; other text goes to the analyzer", () => {
    expect(checkAddressed(msg({ text: "Aria, help" }), "supergroup", BOT)).toMatchObject({
      addressed: true,
      source: "name",
    });
    expect(checkAddressed(msg({ text: "unrelated chatter" }), "supergroup", BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("unicode word boundaries: a Cyrillic name never matches inside a word", () => {
    expect(messageNamesBot("работа всякая", "Бот")).toBe(false);
    expect(messageNamesBot("Бот, привет", "Бот")).toBe(true);
  });

  it("generic or too-short display names never match and never cost the analyzer", () => {
    expect(displayNameMatchable("Bot")).toBe(false);
    expect(displayNameMatchable("ai")).toBe(false);
    const generic = { ...BOT, displayName: "Bot" };
    expect(checkAddressed(msg({ text: "some chatter" }), "supergroup", generic)).toMatchObject({
      addressed: false,
      needsAnalyzer: false,
    });
  });
});
