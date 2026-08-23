import { describe, expect, it } from "vitest";

import {
  inboundMessageEventSchema,
  replyDeliveryEventSchema,
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
      message: { sourceMessageId: "11", content: "hi", sentAt: envelope.occurredAt },
      context: { history: [], participants: [] },
    });
    expect(result.success).toBe(false);
  });

  it("round-trips a reply delivery and defaults preferVoice off", () => {
    const parsed = replyDeliveryEventSchema.parse({
      ...envelope,
      type: "reply.delivery",
      source: "tg",
      assistantId: "assistant-1",
      chatRef: "tg:chat:-2001",
      replyToSourceMessageId: "11",
      text: "the answer",
    });
    expect(parsed.preferVoice).toBe(false);
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
