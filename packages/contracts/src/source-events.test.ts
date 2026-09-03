import { describe, expect, it } from "vitest";

import {
  inboundMessageEventSchema,
  replyDeliveryEventSchema,
  turnCorrelationId,
  turnLifecycleEventSchema,
} from "./source-events";

const envelope = {
  v: 1 as const,
  eventId: "evt-1",
  occurredAt: "2026-08-22T00:00:00.000Z",
  correlationId: "corr-1",
};

describe("source-app events", () => {
  it("accepts a full inbound message event and applies defaults", () => {
    const parsed = inboundMessageEventSchema.parse({
      ...envelope,
      type: "message.inbound",
      source: "tg",
      assistantId: "assistant-1",
      connection: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
      chat: { ref: "tg:chat:-2001", kind: "group", title: "Fixture Group" },
      sender: { ref: "tg:user:1001", isOwner: true, label: "Alice (@alice_example)" },
      addressing: { addressed: true, source: "mention" },
      message: {
        sourceMessageId: "11",
        content: "hello",
        sentAt: "2026-08-22T00:00:00.000Z",
        replyTo: { sourceMessageId: "9", senderLabel: "Bob", text: "earlier" },
      },
      context: {
        history: [
          {
            sourceMessageId: "9",
            role: "user",
            senderRef: "tg:user:1002",
            senderLabel: "Bob",
            content: "earlier",
            sentAt: "2026-08-21T23:00:00.000Z",
          },
        ],
        participants: [{ ref: "tg:user:1001", label: "Alice" }],
      },
    });
    expect(parsed.message.media).toEqual([]);
    expect(parsed.sender.aliases).toEqual([]);
    expect(parsed.context.participants[0].aliases).toEqual([]);
    expect(parsed.addressing.needsAnalyzer).toBe(false);
    expect(parsed.message.replyTo?.stored).toBe(false);
  });

  it("rejects an inbound event with an unscoped chat ref", () => {
    const result = inboundMessageEventSchema.safeParse({
      ...envelope,
      type: "message.inbound",
      source: "tg",
      assistantId: "assistant-1",
      connection: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
      chat: { ref: "-2001", kind: "group" },
      sender: { ref: "tg:user:1001", isOwner: false, label: "Alice" },
      addressing: { addressed: false, needsAnalyzer: true },
      message: { sourceMessageId: "11", content: "hi", sentAt: envelope.occurredAt },
      context: { history: [], participants: [] },
    });
    expect(result.success).toBe(false);
  });

  it("round-trips a reply delivery and defaults silent off", () => {
    const parsed = replyDeliveryEventSchema.parse({
      ...envelope,
      type: "reply.delivery",
      source: "tg",
      assistantId: "assistant-1",
      chatRef: "tg:chat:-2001",
      replyToSourceMessageId: "11",
      text: "the answer",
    });
    expect(parsed.silent).toBe(false);
  });

  it("accepts lifecycle phases and rejects unknown ones", () => {
    for (const phase of ["accepted", "progress", "settled"] as const) {
      expect(
        turnLifecycleEventSchema.parse({
          ...envelope,
          type: "turn.lifecycle",
          source: "tg",
          chatRef: "tg:chat:-2001",
          sourceMessageId: "11",
          phase,
        }).phase,
      ).toBe(phase);
    }
    expect(
      turnLifecycleEventSchema.safeParse({
        ...envelope,
        type: "turn.lifecycle",
        source: "tg",
        chatRef: "tg:chat:-2001",
        sourceMessageId: "11",
        phase: "typing",
      }).success,
    ).toBe(false);
  });
});

describe("turnCorrelationId", () => {
  it("names the chat by ref, so two transports sharing an id never share a turn", () => {
    expect(turnCorrelationId("tg:chat:-1001", "42", "assistant-1")).toBe(
      "tg:chat:-1001:42:assistant-1",
    );
    expect(turnCorrelationId("discord:chat:-1001", "42", "assistant-1")).not.toBe(
      turnCorrelationId("tg:chat:-1001", "42", "assistant-1"),
    );
  });

  it("keeps each assistant's turn on the same message apart", () => {
    expect(turnCorrelationId("tg:chat:-1001", "42", "a")).not.toBe(
      turnCorrelationId("tg:chat:-1001", "42", "b"),
    );
  });

  it("drops the assistant for work that belongs to the message, under the same prefix", () => {
    const message = turnCorrelationId("tg:chat:-1001", "42");
    expect(message).toBe("tg:chat:-1001:42");
    expect(turnCorrelationId("tg:chat:-1001", "42", "a").startsWith(`${message}:`)).toBe(true);
  });

  it("does not let a chat's prefix swallow a longer chat id", () => {
    expect(turnCorrelationId("tg:chat:-100", "42").startsWith("tg:chat:-1001:")).toBe(false);
  });
});
