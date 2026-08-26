import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import { checkAddressed, checkCrossFedAddressed } from "./addressing";

const BOT = { id: 999, username: "fixture_bot" };

function msg(input: Partial<Message> & { text?: string }): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1, type: "supergroup", title: "G" },
    from: { id: 5, is_bot: false, first_name: "A" },
    ...input,
  } as Message;
}

describe("checkAddressed (structural half — the name check is the core's)", () => {
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

  it("any other group text is undecided — the core runs the name check + analyzer", () => {
    // Even text that speaks a name: the assistant's name lives in the core's
    // store (and can be renamed there), so this app never matches names
    // (user decision, 2026-08-24).
    expect(checkAddressed(msg({ text: "Aria, help" }), "supergroup", BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
    expect(checkAddressed(msg({ text: "unrelated chatter" }), "supergroup", BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("every verdict says what it decided on", () => {
    // A message these checks address never reaches the analyzer, so the
    // verdict is the whole account of why the bot answered.
    const decided = [
      checkAddressed(msg({ text: "hi" }), "private", BOT),
      checkAddressed(
        msg({ text: "and you?", reply_to_message: { from: { id: BOT.id } } as never }),
        "supergroup",
        BOT,
      ),
      checkAddressed(msg({ text: "@fixture_bot hi" }), "supergroup", BOT),
      checkAddressed(msg({ text: "unrelated chatter" }), "supergroup", BOT),
    ];
    for (const verdict of decided) expect(verdict.reason).toBeTruthy();
  });

  it("a text-less group message decides nothing and asks for no analyzer", () => {
    expect(checkAddressed(msg({}), "supergroup", BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: false,
    });
  });
});

describe("checkCrossFedAddressed", () => {
  it("an answer to one of this assistant's own messages is addressed to it", () => {
    expect(
      checkCrossFedAddressed({
        text: "good point, though",
        botUsername: "fixture_bot",
        repliesToOwnMessage: true,
      }),
    ).toMatchObject({ addressed: true, source: "reply" });
  });

  it("a spelled-out @username summons this assistant", () => {
    expect(
      checkCrossFedAddressed({
        text: "@fixture_bot what do you think?",
        botUsername: "fixture_bot",
        repliesToOwnMessage: false,
      }),
    ).toMatchObject({ addressed: true, source: "mention" });
  });

  it("anything else with text is undecided — the core runs the name check", () => {
    expect(
      checkCrossFedAddressed({
        text: "Aria, help",
        botUsername: "fixture_bot",
        repliesToOwnMessage: false,
      }),
    ).toMatchObject({ addressed: false, needsAnalyzer: true });
  });

  it("every cross-fed verdict says what it decided on", () => {
    const decided = [
      checkCrossFedAddressed({
        text: "good point",
        botUsername: "fixture_bot",
        repliesToOwnMessage: true,
      }),
      checkCrossFedAddressed({
        text: "@fixture_bot thoughts?",
        botUsername: "fixture_bot",
        repliesToOwnMessage: false,
      }),
      checkCrossFedAddressed({
        text: "Aria, help",
        botUsername: "fixture_bot",
        repliesToOwnMessage: false,
      }),
    ];
    for (const verdict of decided) expect(verdict.reason).toBeTruthy();
  });

  it("an empty message decides nothing and asks for no analyzer", () => {
    expect(
      checkCrossFedAddressed({ text: "   ", botUsername: "fixture_bot", repliesToOwnMessage: false }),
    ).toMatchObject({ addressed: false, needsAnalyzer: false });
  });
});
