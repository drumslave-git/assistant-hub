import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestDb, type TestDb } from "@/test/db";
import { tryGetToolContext } from "@/server/mcp/context";

import { MAX_ONE_SHOT_ATTEMPTS } from "../types";
import { getTaskById } from "./repository";
import { runDueTasks, type DueRunDeps } from "./scheduler";
import { createTaskService, getTask } from "./service";

/**
 * The due-run loop against a real database, with a capturing delivery sink and
 * deterministic generator standing in for the LLM and the bot. What matters
 * here is the settle logic per trigger kind — an interval advances, a spent
 * one-shot is deleted, a failed one-shot retries and finally disables — and
 * that a fire's deliveries come only from the `deliver` binding.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;
const CHAT = "-1001";

/** A `complete` that sends the given texts through the fire's deliver binding. */
function sendingComplete(texts: string[]) {
  return vi.fn().mockImplementation(async () => {
    const toolCtx = tryGetToolContext();
    for (const text of texts) await toolCtx!.deliver!(text);
    return { content: "done", model: "m", latencyMs: 1 };
  });
}

function deps(over: Partial<DueRunDeps> = {}): DueRunDeps {
  return {
    timezone: "UTC",
    personalityPrompt: null,
    complete: sendingComplete(["fired!"]),
    send: vi.fn().mockResolvedValue({ messageId: 1 }),
    db: ctx.db,
    ...over,
  };
}

/** Create a timed task and force it due by aiming the clock past its instant. */
async function dueTask(over: Record<string, unknown> = {}) {
  const task = await createTaskService(
    {
      chatId: CHAT,
      instruction: "Check in.",
      triggerKind: "interval",
      everyMinutes: 10,
      targetUserIds: [],
      enabled: true,
      ...over,
    } as Parameters<typeof createTaskService>[0],
    trigger,
    ctx.db,
  );
  return task;
}

/** A `now` far enough ahead that any freshly-created task is due. */
function later(task: { nextRunAt: string | null }): Date {
  return new Date(Date.parse(task.nextRunAt!) + 1000);
}

describe("runDueTasks", () => {
  it("fires a due interval task, delivers through the sink, and advances the schedule", async () => {
    const task = await dueTask();
    const send = vi.fn().mockResolvedValue({ messageId: 5 });
    const now = later(task);

    const result = await runDueTasks(deps({ send, now }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith(CHAT, "fired!", {
      threadId: null,
      replyToMessageId: undefined,
    });
    const settled = await getTask(task.id, ctx.db);
    // Advanced from the settle instant, and the delivery recorded for variation.
    expect(Date.parse(settled!.nextRunAt!)).toBe(now.getTime() + 10 * 60_000);
    expect(settled!.recentDeliveries).toEqual(["fired!"]);
    expect(settled!.lastRunAt).not.toBeNull();
  });

  it("counts a quiet fire as fired and advances without touching recent deliveries", async () => {
    const task = await dueTask();
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "nothing to report", model: "m", latencyMs: 1 });

    const result = await runDueTasks(deps({ complete, now: later(task) }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    const settled = await getTask(task.id, ctx.db);
    expect(settled!.nextRunAt).not.toBeNull();
    expect(settled!.recentDeliveries).toEqual([]);
  });

  it("deletes a timeout task once it has fired — a spent one-shot", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });

    const result = await runDueTasks(deps({ now: later(task) }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(await getTaskById(ctx.db, task.id)).toBeNull();
  });

  it("keeps a failed one-shot due for retries, then disables it at the cap", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });
    const failing = deps({
      complete: vi.fn().mockRejectedValue(new Error("provider down")),
      now: later(task),
    });

    for (let i = 1; i < MAX_ONE_SHOT_ATTEMPTS; i++) {
      expect(await runDueTasks(failing)).toEqual({ fired: 0, failed: 1 });
      const row = await getTask(task.id, ctx.db);
      expect(row).toMatchObject({ enabled: true, attempts: i });
      expect(row!.nextRunAt).not.toBeNull();
    }
    // The last allowed attempt disables the task — kept, never deleted, so the
    // dashboard can show why it stopped (user decision, 2026-07-20).
    expect(await runDueTasks(failing)).toEqual({ fired: 0, failed: 1 });
    expect(await getTask(task.id, ctx.db)).toMatchObject({
      enabled: false,
      attempts: MAX_ONE_SHOT_ATTEMPTS,
    });
  });

  it("fires nothing when nothing is due", async () => {
    await dueTask();
    const send = vi.fn();

    const result = await runDueTasks(deps({ send, now: new Date(Date.now() - 60_000) }));

    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
