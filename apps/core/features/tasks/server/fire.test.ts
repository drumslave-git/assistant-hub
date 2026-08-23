import { beforeEach, describe, expect, it, vi } from "vitest";

import { tryGetToolContext } from "@/server/mcp/context";

import type { Task } from "../types";
import { buildTaskDirectiveMessage, fireTask, type FireDeps } from "./fire";

/**
 * The timed fire without an LLM or a bot: what the model is told, how delivery
 * is wired, and what counts as success. The load-bearing inversion is that the
 * completion's text is never delivered — only the `deliver` binding the fire
 * puts on the tool context sends anything — so these tests drive `complete`
 * with fakes that either call it or don't.
 */

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    chatId: "-1001",
    threadId: null,
    createdByUserId: "77",
    createdByOwner: false,
    source: "chat",
    instruction: "Check the feed and report anything new.",
    context: null,
    triggerKind: "interval",
    targetUserIds: [],
    everyMinutes: 60,
    delayMinutes: null,
    timeOfDay: null,
    weekdays: null,
    runDate: null,
    enabled: true,
    attempts: 0,
    recentDeliveries: [],
    lastRunAt: null,
    nextRunAt: "2026-08-13T09:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...over,
  };
}

function deps(over: Partial<FireDeps> = {}): FireDeps {
  return {
    personalityPrompt: null,
    complete: vi.fn().mockResolvedValue({ content: "done", model: "m", latencyMs: 1 }),
    send: vi.fn().mockResolvedValue({ messageId: 42 }),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTaskDirectiveMessage", () => {
  it("spells out that only the send tool delivers, and that silence is valid", () => {
    const text = buildTaskDirectiveMessage("remind me to stretch", null, []);
    expect(text).toContain("remind me to stretch");
    expect(text).toMatch(/send_message/);
    expect(text).toMatch(/nothing you merely write in your answer reaches the chat/i);
    expect(text).toMatch(/quiet run is a correct outcome/i);
    // The final text is logged, never sent.
    expect(text).toMatch(/logged, not sent/i);
  });

  it("requires @username mentions for person-directed messages", () => {
    // A bare name notifies nobody on Telegram (operator report, 2026-08-18) —
    // the directive must say so and point at the participants context.
    const text = buildTaskDirectiveMessage("remind R. about the thing", null, []);
    expect(text).toMatch(/@username/);
    expect(text).toMatch(/notifies NOBODY/i);
  });

  it("hands over saved context and labels past deliveries as wording reference only", () => {
    const text = buildTaskDirectiveMessage("nudge about X", "X is the launch checklist.", [
      "Don't forget X!",
    ]);
    expect(text).toContain("X is the launch checklist.");
    expect(text).toContain("WORDING REFERENCE ONLY");
    expect(text).toContain("Don't forget X!");
    expect(text).toMatch(/NOT a source of facts/);
  });
});

describe("fireTask", () => {
  it("binds deliver on the tool context and records what was sent", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 7 });
    const recordReply = vi.fn().mockResolvedValue(undefined);
    // A complete() that behaves like the model calling send_message once.
    const complete = vi.fn().mockImplementation(async () => {
      const ctx = tryGetToolContext();
      expect(ctx?.chatId).toBe("-1001");
      await ctx!.deliver!("Hey, the feed has something new.");
      return { content: "sent one message", model: "m", latencyMs: 1 };
    });

    const result = await fireTask(task(), deps({ complete, send, recordReply }));

    expect(result).toEqual({ ok: true, sent: ["Hey, the feed has something new."] });
    expect(send).toHaveBeenCalledWith("Hey, the feed has something new.", {
      threadId: null,
      replyToMessageId: undefined,
    });
    // Every delivered message is mirrored into history.
    expect(recordReply).toHaveBeenCalledWith({
      chatId: "-1001",
      telegramMessageId: 7,
      content: "Hey, the feed has something new.",
    });
  });

  it("sends standalone, with no reply target for the model to choose", async () => {
    // A fire has no triggering message, so there is nothing to attach to. The
    // model names no target and the binding offers none — which is what keeps a
    // fire from claiming it replied to something that never existed.
    const send = vi.fn().mockResolvedValue({ messageId: 9 });
    const complete = vi.fn().mockImplementation(async () => {
      await tryGetToolContext()!.deliver!("about that");
      return { content: "ok", model: "m", latencyMs: 1 };
    });

    await fireTask(task(), deps({ complete, send }));

    expect(send).toHaveBeenCalledWith("about that", { threadId: null });
  });

  it("binds the send delivery kind, so the reply tool refuses in a fire", async () => {
    const complete = vi.fn().mockImplementation(async () => {
      expect(tryGetToolContext()!.deliveryKind).toBe("send");
      return { content: "ok", model: "m", latencyMs: 1 };
    });

    await fireTask(task(), deps({ complete }));
    expect(complete).toHaveBeenCalled();
  });

  it("injects the chat identity context as a system message when provided", async () => {
    const complete = vi.fn().mockResolvedValue({ content: "ok", model: "m", latencyMs: 1 });
    const roster = "Known participants of this group: Alice (@alice) [user id 1]";

    await fireTask(task(), deps({ complete, chatContext: roster }));

    const messages = complete.mock.calls[0][0] as { role: string; content: string }[];
    const rosterIndex = messages.findIndex((m) => m.content === roster);
    expect(rosterIndex).toBeGreaterThan(0);
    expect(messages[rosterIndex].role).toBe("system");
    // Right after the base system prompt, before the directive — the reply order.
    expect(messages[rosterIndex - 1].role).toBe("system");
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("composes no context block when the chat has none", async () => {
    const complete = vi.fn().mockResolvedValue({ content: "ok", model: "m", latencyMs: 1 });

    await fireTask(task(), deps({ complete, chatContext: "  " }));

    const messages = complete.mock.calls[0][0] as { role: string; content: string }[];
    // Base system prompt + directive only (no personality/language in these deps).
    expect(messages).toHaveLength(2);
  });

  it("treats a fire that sends nothing as a quiet success, not a failure", async () => {
    // "Check X, message only if Y" — the model deciding to stay silent is the
    // feature (user decision, 2026-08-13), so the schedule must advance.
    const result = await fireTask(task(), deps());
    expect(result).toEqual({ ok: true, sent: [] });
  });

  it("fails the fire when generation throws, so a one-shot retries", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));
    const result = await fireTask(task(), deps({ complete }));
    expect(result.ok).toBe(false);
  });

  it("fails the fire when delivery was attempted and nothing got through", async () => {
    const send = vi.fn().mockRejectedValue(new Error("bot is not running"));
    const complete = vi.fn().mockImplementation(async () => {
      await tryGetToolContext()!
        .deliver!("hello")
        .catch(() => undefined);
      return { content: "could not send", model: "m", latencyMs: 1 };
    });

    const result = await fireTask(task(), deps({ complete, send }));

    expect(result.ok).toBe(false);
  });

  it("stays ok when at least one message got through despite a failed attempt", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("flood control"))
      .mockResolvedValueOnce({ messageId: 8 });
    const complete = vi.fn().mockImplementation(async () => {
      const ctx = tryGetToolContext()!;
      await ctx.deliver!("first").catch(() => undefined);
      await ctx.deliver!("second");
      return { content: "ok", model: "m", latencyMs: 1 };
    });

    const result = await fireTask(task(), deps({ complete, send }));

    expect(result).toEqual({ ok: true, sent: ["second"] });
  });
});
