import { describe, expect, it } from "vitest";

import type { IdleJobStatus } from "@/server/jobs/idle-scheduler";
import type { IntervalJobStatus } from "@/server/jobs/interval-scheduler";

import {
  analyticsJobView,
  intervalActivity,
  memoryJobView,
  selfImprovementJobView,
  summaryJobView,
  taskJobView,
  visionJobView,
  ytdlpJobView,
} from "./registry";

function intervalStatus(over: Partial<IntervalJobStatus> = {}): IntervalJobStatus {
  return {
    running: true,
    ticking: false,
    lastTickAt: null,
    lastSummary: null,
    lastError: null,
    progress: null,
    ...over,
  };
}

function idleStatus(over: Partial<IdleJobStatus> = {}): IdleJobStatus {
  return {
    phase: "idle",
    lastRunAt: null,
    lastSummary: null,
    lastError: null,
    nextRunAt: null,
    progress: null,
    ...over,
  };
}

describe("intervalActivity", () => {
  it("maps ticking → running, armed → idle, unarmed → stopped", () => {
    expect(intervalActivity(intervalStatus({ ticking: true }))).toBe("running");
    expect(intervalActivity(intervalStatus({ running: true, ticking: false }))).toBe("idle");
    expect(intervalActivity(intervalStatus({ running: false }))).toBe("stopped");
  });
});

describe("visionJobView", () => {
  it("passes the idle phase straight through as the activity", () => {
    expect(visionJobView(idleStatus({ phase: "running" }), 3).activity).toBe("running");
    expect(visionJobView(idleStatus({ phase: "scheduled" }), 3).activity).toBe("scheduled");
  });

  it("surfaces the pending backlog and disables Run now when empty", () => {
    const withBacklog = visionJobView(idleStatus(), 3);
    expect(withBacklog.backlog).toEqual({ label: "media pending", count: 3 });
    expect(withBacklog.runDisabled).toBe(false);

    const empty = visionJobView(idleStatus(), 0);
    expect(empty.backlog).toBeNull();
    expect(empty.runDisabled).toBe(true);
  });

  it("passes live progress through and flags failure from lastError", () => {
    const progress = { step: "Describing media", current: 1, total: 3 };
    const view = visionJobView(idleStatus({ progress, lastError: "boom" }), 3);
    expect(view.progress).toEqual(progress);
    expect(view.failed).toBe(true);
  });
});

describe("taskJobView", () => {
  const base = {
    status: intervalStatus({ lastTickAt: "2026-07-16T00:00:00.000Z", lastSummary: "1 fired" }),
    overdue: 2,
    nextRunAt: "2026-07-16T09:00:00.000Z",
    asOf: "2026-07-16T00:00:00.000Z",
  };

  it("reports paused with a notice and no Run now while maintenance is on", () => {
    const view = taskJobView({ ...base, paused: true });
    expect(view.activity).toBe("paused");
    expect(view.runDisabled).toBe(true);
    expect(view.notice).toContain("maintenance");
  });

  it("uses the ticker activity and overdue backlog when not paused", () => {
    const view = taskJobView({ ...base, paused: false });
    expect(view.activity).toBe("idle");
    expect(view.backlog).toEqual({ label: "overdue", count: 2 });
    expect(view.lastResult).toBe("1 fired");
  });

  it("renders an errored row when the getter failed", () => {
    const view = taskJobView(null);
    expect(view.activity).toBe("stopped");
    expect(view.failed).toBe(true);
  });
});

describe("daily job views", () => {
  const dailyBase = {
    status: intervalStatus({ ticking: true, progress: { step: "working", current: 1, total: 4 } }),
    nextRunAt: "2026-07-17T03:00:00.000Z",
    runTime: "03:00",
    timezone: "UTC",
    lastResult: { at: "2026-07-16T03:00:00.000Z", summary: "done" },
  };

  it("summary: reports the actual run outcome and pending-days backlog", () => {
    const view = summaryJobView({ ...dailyBase, pendingDays: 5, embeddingsConfigured: true });
    expect(view.activity).toBe("running");
    expect(view.lastRunAt).toBe("2026-07-16T03:00:00.000Z");
    expect(view.lastResult).toBe("done");
    expect(view.backlog).toEqual({ label: "days pending", count: 5 });
    expect(view.progress).toEqual({ step: "working", current: 1, total: 4 });
  });

  it("memory: disables Run now only when both backlogs are empty", () => {
    const view = memoryJobView({
      ...dailyBase,
      pendingNotes: 0,
      pendingExtractionDays: 0,
      embeddingsConfigured: false,
    });
    expect(view.runDisabled).toBe(true);
    expect(view.backlog).toBeNull();
  });

  it("memory: unread chat-days alone are enough work to enable Run now", () => {
    const view = memoryJobView({
      ...dailyBase,
      pendingNotes: 0,
      pendingExtractionDays: 3,
      embeddingsConfigured: false,
    });
    expect(view.runDisabled).toBe(false);
    expect(view.backlog).toEqual({ label: "days to read", count: 3 });
  });

  it("memory: falls back to the note backlog once every day has been read", () => {
    const view = memoryJobView({
      ...dailyBase,
      pendingNotes: 7,
      pendingExtractionDays: 0,
      embeddingsConfigured: false,
    });
    expect(view.runDisabled).toBe(false);
    expect(view.backlog).toEqual({ label: "notes pending", count: 7 });
  });

  it("analytics: warns and disables Run now when no LLM is configured", () => {
    const view = analyticsJobView({
      ...dailyBase,
      pendingUnits: 0,
      llmConfigured: false,
      regenerateBuckets: { hour: [], day: [], week: [], month: [], year: [], all: ["all"] },
    });
    expect(view.runDisabled).toBe(true);
    expect(view.notice).toContain("No LLM configured");
  });

  it("self-improvement: exposes no backlog and always allows Run now", () => {
    const view = selfImprovementJobView(dailyBase);
    expect(view.backlog).toBeNull();
    expect(view.runDisabled).toBe(false);
    expect(view.lastResult).toBe("done");
  });

  it("yt-dlp: warns when no binary is installed, but still allows Run now", () => {
    // "Run now" is exactly what fixes this state, so it must not be disabled by it.
    const view = ytdlpJobView({ ...dailyBase, installedVersion: null, source: "missing" });
    expect(view.notice).toContain("No yt-dlp installed");
    expect(view.runDisabled).toBe(false);
  });

  it("yt-dlp: an installed binary needs no notice", () => {
    const view = ytdlpJobView({
      ...dailyBase,
      installedVersion: "2026.07.04",
      source: "managed",
    });
    expect(view.notice).toBeNull();
    expect(view.backlog).toBeNull();
  });

  it("renders errored rows when a getter failed", () => {
    expect(summaryJobView(null).failed).toBe(true);
    expect(memoryJobView(null).failed).toBe(true);
    expect(analyticsJobView(null).failed).toBe(true);
    expect(selfImprovementJobView(null).failed).toBe(true);
    expect(ytdlpJobView(null).failed).toBe(true);
  });
});
