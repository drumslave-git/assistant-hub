import { describe, expect, it } from "vitest";

import { sendChatMessage, type SendDeps } from "./send";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "./split";

/**
 * The core hands over the whole answer; this side cuts it under Telegram's
 * cap and reports every part, so the mirror holds all of it.
 */

interface Reported {
  sourceMessageId: string;
  content: string;
  replyToSourceMessageId: string | null;
}

function deps() {
  const sends: { text: string; replyToMessageId: number | null }[] = [];
  const reported: Reported[] = [];
  let nextId = 100;
  const d: SendDeps = {
    sender: {
      async sendMessage(_chatId, text, opts) {
        sends.push({ text, replyToMessageId: opts?.replyToMessageId ?? null });
        return { messageId: nextId++, replyToMessageId: opts?.replyToMessageId ?? null };
      },
    },
    publisher: {
      async publish(event: unknown) {
        const e = event as Reported;
        reported.push({
          sourceMessageId: e.sourceMessageId,
          content: e.content,
          replyToSourceMessageId: e.replyToSourceMessageId,
        });
      },
    } as unknown as SendDeps["publisher"],
    running: () => [],
  };
  return { d, sends, reported };
}

describe("sendChatMessage", () => {
  it("sends short text once and reports it once", async () => {
    const { d, sends, reported } = deps();
    const sent = await sendChatMessage(d, {
      chatId: "-100",
      assistantId: "anna",
      text: "hello",
      replyToMessageId: 7,
    });
    expect(sent).toEqual({ messageId: 100, replyToMessageId: 7, messageIds: [100] });
    expect(sends).toEqual([{ text: "hello", replyToMessageId: 7 }]);
    expect(reported).toEqual([
      { sourceMessageId: "100", content: "hello", replyToSourceMessageId: "7" },
    ]);
  });

  it("splits a long answer under the cap, replies with every part, reports each", async () => {
    const { d, sends, reported } = deps();
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    const sent = await sendChatMessage(d, {
      chatId: "-100",
      assistantId: "anna",
      text: `${a}\n\n${b}`,
      replyToMessageId: 7,
    });
    expect(sent.messageId).toBe(100);
    expect(sent.messageIds).toEqual([100, 101]);
    expect(sends.map((s) => s.text)).toEqual([a, b]);
    expect(sends.every((s) => s.replyToMessageId === 7)).toBe(true);
    for (const s of sends) {
      expect(s.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    expect(reported.map((r) => [r.sourceMessageId, r.content.length])).toEqual([
      ["100", 3000],
      ["101", 3000],
    ]);
  });

  it("hands a failed delivered report to the caller and still returns the send", async () => {
    const { d, sends } = deps();
    const failures: number[] = [];
    d.publisher = {
      async publish() {
        throw new Error("bus down");
      },
    } as unknown as SendDeps["publisher"];
    d.onReportFailure = (messageId) => failures.push(messageId);
    const sent = await sendChatMessage(d, { chatId: "1", assistantId: null, text: "hi" });
    expect(sent.messageId).toBe(100);
    expect(sends).toHaveLength(1);
    expect(failures).toEqual([100]);
  });
});
