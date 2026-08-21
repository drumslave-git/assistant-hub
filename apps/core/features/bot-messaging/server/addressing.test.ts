import type { Message, MessageEntity } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import { BOT, makeMessage, makeUser } from "@/test/__mocks__/telegram";
import { checkAddressed, displayNameMatchable, messageNamesBot } from "./addressing";

/** The bot resolves to id 42; any other id is a different participant. */
function user(id: number) {
  return id === BOT.id
    ? makeUser(id, { is_bot: true, first_name: BOT.displayName })
    : makeUser(id, { first_name: "Someone" });
}

/** A group message; only the fields addressing reads are required. */
function msg(partial: Partial<Message> = {}): Message {
  return makeMessage({ chat: { id: 1, type: "group" }, ...partial });
}

/** A `text` message carrying a single entity. */
function withEntity(text: string, entity: MessageEntity): Message {
  return msg({ text, entities: [entity] });
}

/** A minimal `reply_to_message` authored by the given user. */
function replyFrom(id: number): Message["reply_to_message"] {
  return { from: user(id) } as unknown as Message["reply_to_message"];
}

describe("checkAddressed", () => {
  it("addresses every private message", () => {
    expect(checkAddressed(msg({ text: "hello" }), "private", BOT)).toEqual({
      addressed: true,
      source: "private",
    });
  });

  it("ignores plain group chatter", () => {
    expect(checkAddressed(msg({ text: "just talking" }), "group", BOT).addressed).toBe(false);
  });

  it("addresses a message that speaks the display name", () => {
    expect(checkAddressed(msg({ text: "aria, what time is it?" }), "group", BOT)).toMatchObject({
      addressed: true,
      source: "name",
    });
  });

  it("addresses the display name mid-sentence and regardless of case", () => {
    expect(checkAddressed(msg({ text: "so ARIA should know this" }), "group", BOT)).toMatchObject({
      addressed: true,
      source: "name",
    });
  });

  it("addresses a reply to one of the bot's messages", () => {
    const m = msg({ text: "and you?", reply_to_message: replyFrom(42) });
    expect(checkAddressed(m, "supergroup", BOT)).toEqual({ addressed: true, source: "reply" });
  });

  it("does not address a reply to someone else", () => {
    const m = msg({ text: "and you?", reply_to_message: replyFrom(99) });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("addresses an @username mention entity (case-insensitive)", () => {
    const m = withEntity("hey @mybot help", { type: "mention", offset: 4, length: 6 });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "mention" });
  });

  it("addresses a text_mention entity for the bot id", () => {
    const m = withEntity("hey there help", {
      type: "text_mention",
      offset: 4,
      length: 5,
      user: user(42),
    });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "mention" });
  });

  it("does not address an @mention of a different user", () => {
    const m = withEntity("hey @someoneelse", { type: "mention", offset: 4, length: 12 });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("addresses a /command@botusername targeting the bot", () => {
    const m = withEntity("/start@mybot", { type: "bot_command", offset: 0, length: 12 });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "command" });
  });

  it("does not address a bare /command with no bot suffix in a group", () => {
    const m = withEntity("/start", { type: "bot_command", offset: 0, length: 6 });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("ignores channels and other chat types", () => {
    expect(checkAddressed(msg({ text: "@mybot" }), "channel", BOT).addressed).toBe(false);
  });
});

describe("checkAddressed — voice transcripts", () => {
  it("hears the display name spoken in a voice message", () => {
    expect(checkAddressed(msg({}), "group", BOT, "aria, what time is it?")).toMatchObject({
      addressed: true,
      source: "name",
    });
  });

  it("hands an unnamed transcript to the analyzer instead of staying silent", () => {
    expect(checkAddressed(msg({}), "group", BOT, "how was your weekend?")).toEqual({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("stays not-addressed when there is neither text nor transcript", () => {
    expect(checkAddressed(msg({}), "group", BOT, "")).toEqual({ addressed: false });
    expect(checkAddressed(msg({}), "group", BOT, "   ")).toEqual({ addressed: false });
  });

  it("prefers the typed caption over the transcript when both exist", () => {
    // A caption that names the bot is decisive regardless of the transcript.
    expect(
      checkAddressed(msg({ text: "aria look" }), "group", BOT, "unrelated words"),
    ).toMatchObject({ addressed: true, source: "name" });
  });
});

describe("checkAddressed — handing off to the analyzer", () => {
  it("leaves group text the cheap checks could not settle undecided", () => {
    expect(checkAddressed(msg({ text: "how was your weekend?" }), "group", BOT)).toEqual({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("does not hand off a message it already settled", () => {
    expect(checkAddressed(msg({ text: "aria hi" }), "group", BOT).needsAnalyzer).toBeUndefined();
  });

  it("does not hand off captionless media — there is no text to judge", () => {
    expect(checkAddressed(msg({}), "group", BOT)).toEqual({ addressed: false });
  });

  it("does not hand off private chats or channels", () => {
    expect(checkAddressed(msg({ text: "hi" }), "private", BOT).needsAnalyzer).toBeUndefined();
    expect(checkAddressed(msg({ text: "hi" }), "channel", BOT).needsAnalyzer).toBeUndefined();
  });

  it("does not hand off when the display name is too generic to be worth finding", () => {
    const generic = { ...BOT, displayName: "Bot" };
    expect(checkAddressed(msg({ text: "the bot is down again" }), "group", generic)).toEqual({
      addressed: false,
    });
  });
});

describe("messageNamesBot", () => {
  it("requires the name to stand as its own word", () => {
    expect(messageNamesBot("aria!", "Aria")).toBe(true);
    expect(messageNamesBot("arias and songs", "Aria")).toBe(false);
    expect(messageNamesBot("Arianna said hi", "Aria")).toBe(false);
  });

  it("does not match the name inside someone else's @handle", () => {
    expect(messageNamesBot("@ariafan hello", "Aria")).toBe(false);
    expect(messageNamesBot("@aria hello", "Aria")).toBe(false);
  });

  // `\b`/`\w` are ASCII-only, so an ASCII-boundary regex treats every Cyrillic
  // letter as a boundary: a bot named "Бот" would answer to "работа".
  it("applies word boundaries outside the ASCII range", () => {
    expect(messageNamesBot("работа не ждет", "Бот")).toBe(false);
    expect(messageNamesBot("Бот, привет", "Бот")).toBe(true);
  });

  it("does not match a name it was told not to look for", () => {
    expect(messageNamesBot("the bot is down", "Bot")).toBe(false);
    expect(messageNamesBot("hi al", "Al")).toBe(false);
  });
});

describe("displayNameMatchable", () => {
  it("rejects generic names and names too short to match cleanly", () => {
    expect(displayNameMatchable("Aria")).toBe(true);
    expect(displayNameMatchable("Bot")).toBe(false);
    expect(displayNameMatchable("ASSISTANT")).toBe(false);
    expect(displayNameMatchable("Al")).toBe(false);
    expect(displayNameMatchable("  ")).toBe(false);
  });
});
