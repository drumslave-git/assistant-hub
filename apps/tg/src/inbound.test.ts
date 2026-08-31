import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import type { AssistantConnection } from "./connections";
import { processIncomingMessage, type InboundDeps } from "./inbound";
import { SeenCache } from "./updates";

/**
 * The stateless inbound half (Phase 7): one Telegram update becomes one
 * transport-update event — per-connection structural verdicts computed here,
 * media riding as payload, group duplicates suppressed in-process. What the
 * core DOES with the event is its ingest's business (covered there).
 */

const anna: AssistantConnection = {
  assistantId: "anna",
  botId: 1001,
  identity: { botUsername: "anna_bot", botDisplayName: "Anna" },
};
const igor: AssistantConnection = {
  assistantId: "igor",
  botId: 1002,
  identity: { botUsername: "igor_bot", botDisplayName: "Igor" },
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 42,
    date: 1_756_400_000,
    chat: { id: -100200, type: "supergroup", title: "The group" },
    from: { id: 7, is_bot: false, first_name: "Sam", username: "sam" },
    text: "hello @igor_bot",
    ...overrides,
  } as Message;
}

function deps(overrides: Partial<InboundDeps> = {}): InboundDeps {
  return {
    assistantId: "anna",
    botId: 1001,
    botToken: "token",
    running: () => [anna, igor],
    seen: new SeenCache(),
    download: async () => null,
    ...overrides,
  };
}

describe("processIncomingMessage", () => {
  it("forwards one event with a structural verdict per running connection", async () => {
    const result = await processIncomingMessage(message(), deps());
    expect(result.status).toBe("forwarded");
    if (result.status !== "forwarded") return;
    const event = result.event;
    expect(event).toMatchObject({
      type: "transport.message",
      source: "tg",
      receivedBy: "anna",
      chat: { id: "-100200", kind: "group", title: "The group" },
      sender: { userId: "7", username: "sam" },
      dedupeKey: "-100200:42",
    });
    // The @mention names igor's bot: his verdict is addressed, anna's is the
    // analyzer's to settle.
    const verdicts = new Map(event.receivers.map((r) => [r.assistantId, r.addressing]));
    expect(verdicts.get("igor")).toMatchObject({ addressed: true, source: "mention" });
    expect(verdicts.get("anna")).toMatchObject({ addressed: false, needsAnalyzer: true });
  });

  it("suppresses the second receipt of a group message (presence-only)", async () => {
    const seen = new SeenCache();
    const first = await processIncomingMessage(message(), deps({ seen }));
    expect(first.status).toBe("forwarded");
    const second = await processIncomingMessage(
      message(),
      deps({ seen, assistantId: "igor", botId: 1002 }),
    );
    expect(second.status).toBe("duplicate");
  });

  it("keeps DM streams per bot: same message id, different dedupe keys", async () => {
    const dm = message({
      chat: { id: 7, type: "private", first_name: "Sam" } as Message["chat"],
      text: "hi",
    });
    const seen = new SeenCache();
    const toAnna = await processIncomingMessage(dm, deps({ seen }));
    const toIgor = await processIncomingMessage(
      dm,
      deps({ seen, assistantId: "igor", botId: 1002 }),
    );
    expect(toAnna.status).toBe("forwarded");
    expect(toIgor.status).toBe("forwarded");
    if (toAnna.status !== "forwarded" || toIgor.status !== "forwarded") return;
    expect(toAnna.event.dedupeKey).toBe("7:anna:42");
    expect(toIgor.event.dedupeKey).toBe("7:igor:42");
    // A DM lists the receiving connection alone.
    expect(toAnna.event.receivers.map((r) => r.assistantId)).toEqual(["anna"]);
    expect(toAnna.event.receivers[0].addressing).toMatchObject({
      addressed: true,
      source: "private",
    });
  });

  it("recognizes a reply to another running bot as that assistant's", async () => {
    const result = await processIncomingMessage(
      message({
        reply_to_message: {
          message_id: 30,
          date: 1_756_399_000,
          chat: { id: -100200, type: "supergroup", title: "The group" },
          from: { id: 1002, is_bot: true, first_name: "Igor" },
          text: "igor said this",
        } as Message["reply_to_message"],
      }),
      deps(),
    );
    expect(result.status).toBe("forwarded");
    if (result.status !== "forwarded") return;
    expect(result.event.message.replyTo).toMatchObject({
      sourceMessageId: "30",
      authorAssistantId: "igor",
      author: null,
    });
  });

  it("drops bot-authored and contentless updates", async () => {
    const fromBot = await processIncomingMessage(
      message({ from: { id: 1002, is_bot: true, first_name: "Igor" } }),
      deps(),
    );
    expect(fromBot).toMatchObject({ status: "skipped", reason: "bot_or_anonymous_sender" });

    const empty = await processIncomingMessage(message({ text: undefined }), deps());
    expect(empty).toMatchObject({ status: "skipped", reason: "no_content" });
  });
});
