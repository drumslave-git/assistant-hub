import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deferred } from "@/test/async";

import { createIdleScheduler, type JobRunContext } from "./idle-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIdleScheduler", () => {
  it("runs the job only after the debounce elapses on activity", async () => {
    const run = vi.fn(async () => ({ summary: "done" }));
    const s = createIdleScheduler({ name: "t", debounceMs: 1000, run });

    s.onActivity();
    expect(s.getStatus().phase).toBe("scheduled");
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.getStatus().phase).toBe("idle");
    expect(s.getStatus().lastSummary).toBe("done");
  });

  it("re-arms the debounce on repeated activity so it only runs when quiet", async () => {
    const run = vi.fn(async () => ({ summary: "done" }));
    const s = createIdleScheduler({ name: "t", debounceMs: 1000, run });

    s.onActivity();
    await vi.advanceTimersByTimeAsync(800);
    s.onActivity(); // resets the timer
    await vi.advanceTimersByTimeAsync(800);
    expect(run).not.toHaveBeenCalled(); // 800 < 1000 since last activity

    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runNow fires immediately, bypassing the debounce", async () => {
    const run = vi.fn(async () => ({ summary: "now" }));
    const s = createIdleScheduler({ name: "t", debounceMs: 60_000, run });

    s.runNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts a running batch and re-arms when activity arrives mid-run", async () => {
    const gate = deferred<void>();
    let observedAbort = false;
    const run = vi.fn(async (ctx: JobRunContext) => {
      await gate.promise;
      observedAbort = ctx.isAborted();
      return { summary: "done" };
    });
    const s = createIdleScheduler({ name: "t", debounceMs: 1000, run });

    s.runNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().phase).toBe("running");

    s.onActivity(); // mid-run — should flip the abort flag and re-arm
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(observedAbort).toBe(true);

    // A fresh run is scheduled after the debounce (the re-arm).
    expect(s.getStatus().phase).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("records the error and settles idle when the job throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = createIdleScheduler({ name: "t", debounceMs: 100, run });

    s.onActivity();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.getStatus().phase).toBe("idle");
    expect(s.getStatus().lastError).toBe("boom");
    expect(s.getStatus().lastSummary).toBe("boom");
  });

  it("publishes progress during a run and clears it when the run settles", async () => {
    const gate = deferred<void>();
    const run = vi.fn(async (ctx: JobRunContext) => {
      ctx.reportProgress({ step: "working", current: 1, total: 2 });
      await gate.promise;
      return { summary: "done" };
    });
    const s = createIdleScheduler({ name: "t", debounceMs: 1000, run });

    s.runNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().phase).toBe("running");
    expect(s.getStatus().progress).toEqual({ step: "working", current: 1, total: 2 });

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().phase).toBe("idle");
    expect(s.getStatus().progress).toBeNull();
  });

  it("stop cancels a pending run and ignores further activity", async () => {
    const run = vi.fn(async () => ({ summary: "done" }));
    const s = createIdleScheduler({ name: "t", debounceMs: 1000, run });

    s.onActivity();
    s.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();

    s.onActivity(); // ignored after stop
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();
  });
});
