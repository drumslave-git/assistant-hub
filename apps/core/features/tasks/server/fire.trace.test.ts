import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../types";
import { fireTask, type FireDeps } from "./fire";

/**
 * How a fire opens its trace — the one thing `fire.test.ts` cannot see through
 * the real recorder: the action and trigger a regular fire records versus the
 * dashboard's manual fire (`manual-fire`, the caller's trigger, and the task id
 * as the opening correlation either way).
 */

vi.mock("@/server/trace", () => ({
  startTrace: vi.fn(async () => ({
    id: "trace-1",
    event: vi.fn(),
    setInputSummary: vi.fn(),
    relate: vi.fn(),
    succeed: vi.fn(),
    skip: vi.fn(),
    fail: vi.fn(),
  })),
}));

const { startTrace } = vi.mocked(await import("@/server/trace"));

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    chatId: "-1001",
    threadId: null,
    createdByUserId: "77",
    createdByOwner: false,
    source: "chat",
    instruction: "Check the feed.",
    context: null,
    triggerKind: "schedule",
    targetUserIds: [],
    everyMinutes: null,
    delayMinutes: null,
    timeOfDay: "09:00",
    weekdays: null,
    runDate: "2026-08-18",
    enabled: true,
    attempts: 0,
    recentDeliveries: [],
    lastRunAt: null,
    nextRunAt: "2026-08-18T06:00:00.000Z",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...over,
  };
}

function deps(): FireDeps {
  return {
    personalityPrompt: null,
    complete: vi.fn().mockResolvedValue({ content: "ok", model: "m", latencyMs: 1 }),
    send: vi.fn().mockResolvedValue({ messageId: 42 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fireTask trace opening", () => {
  it("records a regular fire as tasks/fire with the cron trigger and task correlation", async () => {
    await fireTask(task(), deps());

    expect(startTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "fire",
        trigger: { kind: "cron", actor: "-1001", correlationId: "task-1" },
      }),
    );
  });

  it("records a manual fire as tasks/manual-fire with the caller's trigger", async () => {
    await fireTask(task(), deps(), { action: "manual-fire", trigger: { kind: "dashboard" } });

    expect(startTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "manual-fire",
        // The dashboard trigger, still correlated to the task so the run joins
        // the task's flow in Debug.
        trigger: { kind: "dashboard", actor: "-1001", correlationId: "task-1" },
      }),
    );
  });
});
