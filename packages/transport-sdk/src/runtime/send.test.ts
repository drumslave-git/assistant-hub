import type { TransportUpdateEvent } from "@assistant-hub-swarm/contracts";
import { describe, expect, it } from "vitest";

import { sendChatMessage, type SendContext } from "./send";
import type { PlatformConnection, SendOptions, TransportDescriptor } from "./types";

/**
 * One send is one rule for every transport: split under the platform's cap,
 * send each part, and report every part as its own `message.delivered` —
 * with what the platform actually attached, not what was asked for.
 */

const descriptor: TransportDescriptor = {
  id: "demo",
  name: "Demo",
  connectionConfigSchema: [],
  maxMessageLength: 100,
  typingRefreshMs: 5000,
};

function harness(
  connection: Partial<PlatformConnection> = {},
): { ctx: SendContext; sent: { text: string; opts?: SendOptions }[]; published: TransportUpdateEvent[] } {
  const sent: { text: string; opts?: SendOptions }[] = [];
  const published: TransportUpdateEvent[] = [];
  let nextId = 1;
  const platform: PlatformConnection = {
    identity: () => ({ id: "bot", identity: { botUsername: "b", botDisplayName: "B" } }),
    sendMessage: async (_chatId, text, opts) => {
      sent.push({ text, opts });
      return {
        sourceMessageId: String(nextId++),
        replyToSourceMessageId: opts?.replyToSourceMessageId ?? null,
      };
    },
    isDirectChat: async () => false,
    close: async () => undefined,
    ...connection,
  };
  return {
    sent,
    published,
    ctx: {
      descriptor,
      publisher: {
        publish: async (event) => {
          published.push(event);
        },
        close: async () => undefined,
      },
      running: () => [
        { assistantId: "a1", botId: "bot", identity: { botUsername: "b", botDisplayName: "B" } },
      ],
      connectionFor: () => platform,
    },
  };
}

describe("sendChatMessage", () => {
  it("reports one delivered event per part, in order", async () => {
    const { ctx, sent, published } = harness();
    const text = "Sentence about nothing. ".repeat(20).trim();

    const result = await sendChatMessage(ctx, {
      chatId: "c1",
      assistantId: "a1",
      direct: false,
      text,
    });

    expect(sent.length).toBeGreaterThan(1);
    expect(published).toHaveLength(sent.length);
    expect(published.every((event) => event.type === "message.delivered")).toBe(true);
    // The first message is what a later reply or deletion names.
    expect(result.sourceMessageId).toBe("1");
    expect(result.sourceMessageIds).toEqual(sent.map((_, i) => String(i + 1)));
    // The whole answer was delivered, not truncated.
    expect(sent.map((s) => s.text).join(" ")).toBe(text);
  });

  it("reports what the platform attached, not what was asked for", async () => {
    // A platform that silently drops the reply target.
    const { ctx, published } = harness({
      sendMessage: async () => ({ sourceMessageId: "7", replyToSourceMessageId: null }),
    });

    const result = await sendChatMessage(ctx, {
      chatId: "c1",
      assistantId: "a1",
      direct: false,
      text: "short",
      replyToSourceMessageId: "5",
    });

    expect(result.replyToSourceMessageId).toBeNull();
    expect(published[0]).toMatchObject({
      type: "message.delivered",
      replyToSourceMessageId: null,
      content: "short",
    });
  });

  it("keys the dedupe per assistant in a direct chat and per chat in a shared one", async () => {
    const direct = harness();
    await sendChatMessage(direct.ctx, {
      chatId: "c1",
      assistantId: "a1",
      direct: true,
      text: "hi",
    });
    const shared = harness();
    await sendChatMessage(shared.ctx, {
      chatId: "c1",
      assistantId: "a1",
      direct: false,
      text: "hi",
    });

    const keyOf = (event: TransportUpdateEvent) =>
      (event as { dedupeKey: string }).dedupeKey;
    expect(keyOf(direct.published[0])).not.toBe(keyOf(shared.published[0]));
  });

  it("lets the caller see a send failure and reports nothing for it", async () => {
    const { ctx, published } = harness({
      sendMessage: async () => {
        throw new Error("platform said no");
      },
    });
    await expect(
      sendChatMessage(ctx, { chatId: "c1", assistantId: "a1", direct: false, text: "hi" }),
    ).rejects.toThrow("platform said no");
    expect(published).toHaveLength(0);
  });

  it("delivers the message even when the delivered report cannot be published", async () => {
    const { ctx } = harness();
    const failures: string[] = [];
    const result = await sendChatMessage(
      {
        ...ctx,
        publisher: {
          publish: async () => {
            throw new Error("redis is down");
          },
          close: async () => undefined,
        },
        onReportFailure: (id) => failures.push(id),
      },
      { chatId: "c1", assistantId: "a1", direct: false, text: "hi" },
    );
    // The message is in the chat; the mirror missing it is the lesser evil.
    expect(result.sourceMessageId).toBe("1");
    expect(failures).toEqual(["1"]);
  });
});
