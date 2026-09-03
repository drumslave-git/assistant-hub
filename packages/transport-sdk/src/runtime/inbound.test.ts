import { describe, expect, it } from "vitest";

import { buildInboundEvent } from "./inbound";
import { SeenCache } from "./updates";
import type { AddressingRule, BotIdentity, InboundMessage, TransportDescriptor } from "./types";

/**
 * The contract logic every transport used to own a copy of: what forwards,
 * what only proves presence, and who ends up in the receivers list.
 */

const descriptor: TransportDescriptor = {
  id: "demo",
  name: "Demo",
  connectionConfigSchema: [],
  maxMessageLength: 2000,
  typingRefreshMs: 5000,
};

const bot = (assistantId: string, id: string): BotIdentity & { assistantId: string } => ({
  assistantId,
  id,
  identity: { botUsername: `bot_${assistantId}`, botDisplayName: `Bot ${assistantId}` },
});

const addressed: AddressingRule<unknown> = () => ({
  addressed: true,
  needsAnalyzer: false,
  source: "mention",
});

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: "chat-1",
    direct: false,
    sourceMessageId: "10",
    content: "hello",
    sentAt: new Date().toISOString(),
    sender: { userId: "u1", username: "someone", firstName: "Some", lastName: null },
    ...overrides,
  };
}

describe("buildInboundEvent", () => {
  it("skips a message with neither text nor media", () => {
    const result = buildInboundEvent({
      descriptor,
      raw: {},
      message: message({ content: "   " }),
      addressing: addressed,
      receivedBy: "a1",
      running: [bot("a1", "100")],
      seen: new SeenCache(),
    });
    expect(result.status).toBe("skipped");
  });

  it("forwards a shared-chat message once and calls the rest presence", () => {
    const seen = new SeenCache();
    const running = [bot("a1", "100"), bot("a2", "200")];
    const args = { descriptor, raw: {}, message: message(), addressing: addressed, running, seen };

    const first = buildInboundEvent({ ...args, receivedBy: "a1" });
    expect(first.status).toBe("forwarded");
    // Both bots in the chat are offered as receivers, judged separately.
    if (first.status !== "forwarded") throw new Error("unreachable");
    expect(first.event.receivers.map((r) => r.assistantId)).toEqual(["a1", "a2"]);
    expect(first.event.chat.kind).toBe("group");

    const second = buildInboundEvent({ ...args, receivedBy: "a2" });
    expect(second.status).toBe("duplicate");
    if (second.status !== "duplicate") throw new Error("unreachable");
    expect(second.presence).toMatchObject({
      type: "transport.presence",
      source: "demo",
      chatId: "chat-1",
      assistantId: "a2",
    });
  });

  it("keeps direct chats as separate streams per assistant", () => {
    const seen = new SeenCache();
    const running = [bot("a1", "100"), bot("a2", "200")];
    const args = {
      descriptor,
      raw: {},
      message: message({ direct: true }),
      addressing: addressed,
      running,
      seen,
    };

    const first = buildInboundEvent({ ...args, receivedBy: "a1" });
    const second = buildInboundEvent({ ...args, receivedBy: "a2" });
    // Same chat id and message id, but one person talking to one bot: both
    // forward, and each lists only the bot that received it.
    expect([first.status, second.status]).toEqual(["forwarded", "forwarded"]);
    if (first.status !== "forwarded" || second.status !== "forwarded") {
      throw new Error("unreachable");
    }
    expect(first.event.receivers.map((r) => r.assistantId)).toEqual(["a1"]);
    expect(second.event.receivers.map((r) => r.assistantId)).toEqual(["a2"]);
    expect(first.event.dedupeKey).not.toBe(second.event.dedupeKey);
    expect(first.event.chat.kind).toBe("direct");
  });

  it("resolves a quoted bot message to the assistant that wrote it", () => {
    const result = buildInboundEvent({
      descriptor,
      raw: {},
      message: message({
        replyTo: {
          sourceMessageId: "9",
          hasMedia: false,
          text: "an earlier answer",
          author: { userId: "200", username: "bot_a2", firstName: "Bot", lastName: null },
          authorPlatformId: "200",
        },
      }),
      addressing: addressed,
      receivedBy: "a1",
      running: [bot("a1", "100"), bot("a2", "200")],
      seen: new SeenCache(),
    });
    if (result.status !== "forwarded") throw new Error("unreachable");
    expect(result.event.message.replyTo?.authorAssistantId).toBe("a2");
  });

  it("puts the source's own correlation on the event", () => {
    const result = buildInboundEvent({
      descriptor,
      raw: {},
      message: message(),
      addressing: addressed,
      receivedBy: "a1",
      running: [bot("a1", "100")],
      seen: new SeenCache(),
    });
    if (result.status !== "forwarded") throw new Error("unreachable");
    expect(result.event.correlationId).toBe("demo:chat:chat-1:10");
  });
});
