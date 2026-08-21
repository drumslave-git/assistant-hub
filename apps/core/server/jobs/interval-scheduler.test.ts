import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntervalScheduler, type IntervalRunContext } from "./interval-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIntervalScheduler", () => {
  it("runs the job on each tick once started", async () => {
    const run = vi.fn(async () => ({ summary: "ok" }));
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    s.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(s.getStatus()).toMatchObject({ running: true, ticking: false, lastSummary: "ok" });
  });

  it("stops ticking after stop()", async () => {
    const run = vi.fn(async () => ({ summary: "ok" }));
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.getStatus().running).toBe(false);
  });

  it("skips overlapping ticks while one is in flight", async () => {
    let resolve!: () => void;
    const run = vi.fn(
      () =>
        new Promise<{ summary: string }>((r) => {
          resolve = () => r({ summary: "ok" });
        }),
    );
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    s.start();
    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts, does not resolve
    await vi.advanceTimersByTimeAsync(1000); // tick 2 would fire but is skipped
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(1000); // now a fresh tick can run
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runNow triggers an immediate tick and records errors", async () => {
    const run = vi
      .fn<() => Promise<{ summary: string }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ summary: "recovered" });
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    await s.runNow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.getStatus()).toMatchObject({ lastError: "boom", lastSummary: "boom" });
    await s.runNow();
    expect(s.getStatus()).toMatchObject({ lastError: null, lastSummary: "recovered" });
  });

  it("publishes progress during a tick and clears it when the tick settles", async () => {
    let resolve!: () => void;
    const run = vi.fn((ctx: IntervalRunContext) => {
      ctx.reportProgress({ step: "step", current: 2, total: 5 });
      return new Promise<{ summary: string }>((r) => {
        resolve = () => r({ summary: "ok" });
      });
    });
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getStatus().progress).toEqual({ step: "step", current: 2, total: 5 });
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().progress).toBeNull();
  });

  it("start is idempotent", async () => {
    const run = vi.fn(async () => ({ summary: "ok" }));
    const s = createIntervalScheduler({ name: "t", tickMs: 1000, run });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
