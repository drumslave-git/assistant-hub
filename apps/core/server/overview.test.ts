import { describe, expect, it } from "vitest";

import { setupTempTraceStore } from "@/test/trace-store";
import { getOverviewActivity, OVERVIEW_WINDOW_HOURS } from "./overview";
import { startTrace, type StartTraceInput } from "./trace/recorder";

/**
 * The Overview's activity read. Docker-free: it aggregates the file-backed trace
 * store, which the temp-store helper isolates per test.
 */

const reply: StartTraceInput = {
  feature: "bot-messaging",
  action: "reply",
  trigger: { kind: "transport", actor: "user-1", correlationId: "chat-1:10" },
  inputSummary: "hello",
};

/** One settled reply trace, optionally failing and optionally reporting usage. */
async function seedReply(
  overrides: Partial<StartTraceInput> = {},
  opts: { fail?: boolean; promptTokens?: number; completionTokens?: number } = {},
): Promise<string> {
  const trace = await startTrace({ ...reply, ...overrides });
  if (opts.promptTokens !== undefined || opts.completionTokens !== undefined) {
    await trace.event({
      type: "llm_response",
      message: "answered",
      usage: {
        model: "test-model",
        promptTokens: opts.promptTokens ?? 0,
        completionTokens: opts.completionTokens ?? 0,
        totalTokens: (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0),
      },
    });
  }
  if (opts.fail) await trace.fail(new Error("boom"));
  else await trace.succeed({ outputSummary: "hi" });
  return trace.id;
}

setupTempTraceStore();

describe("getOverviewActivity", () => {
  it("counts the window's workload and tokens", async () => {
    await seedReply({}, { promptTokens: 100, completionTokens: 20 });
    await seedReply(
      { trigger: { kind: "transport", actor: "user-2", correlationId: "chat-1:11" } },
      { promptTokens: 50, completionTokens: 5 },
    );
    await seedReply({}, { fail: true });

    const activity = await getOverviewActivity();
    expect(activity.handled).toBe(3);
    expect(activity.replied).toBe(2);
    expect(activity.failed).toBe(1);
    // Two distinct triggering users, not three traces.
    expect(activity.activeUsers).toBe(2);
    expect(activity.promptTokens).toBe(150);
    expect(activity.completionTokens).toBe(25);
  });

  it("reports a window that starts OVERVIEW_WINDOW_HOURS before now", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const activity = await getOverviewActivity(now);
    expect(activity.since).toBe("2026-08-13T12:00:00.000Z");
    expect(OVERVIEW_WINDOW_HOURS).toBe(24);
  });

  it("excludes work outside the window from the counts", async () => {
    await seedReply();
    // A window that ended before the trace was recorded sees no traffic at all.
    const activity = await getOverviewActivity(new Date("2020-01-01T00:00:00.000Z"));
    expect(activity.handled).toBe(0);
    expect(activity.promptTokens).toBe(0);
  });

  it("lists failures regardless of age, and says how many are recent", async () => {
    await seedReply({}, { fail: true });

    // The lists are deliberately not windowed: asked about a window long past,
    // the failure is still listed — an empty panel would read as "nothing wrong".
    const old = await getOverviewActivity(new Date("2020-01-01T00:00:00.000Z"));
    expect(old.failures).toHaveLength(1);
    expect(old.failuresInWindow).toBe(0);

    const now = await getOverviewActivity();
    expect(now.failures).toHaveLength(1);
    expect(now.failuresInWindow).toBe(1);
  });

  it("lists recent actions newest-first as headers, without their events", async () => {
    await seedReply({ action: "first" }, { promptTokens: 1 });
    await seedReply({ action: "second" }, { promptTokens: 1 });

    const activity = await getOverviewActivity();
    expect(activity.recent.map((t) => t.action).sort()).toEqual(["first", "second"]);
    // Ordering asserted as a property, not a fixed pair: both traces are seeded
    // inside the same millisecond, so their relative order is a stable-sort tie.
    const times = activity.recent.map((t) => t.startedAt);
    expect(times).toEqual([...times].sort().reverse());
    // Headers only — the Overview renders a list, not event bodies.
    expect(activity.recent[0].events).toEqual([]);
  });

  it("counts described media separately from handled messages", async () => {
    await seedReply();
    const vision = await startTrace({
      feature: "vision",
      action: "describe",
      trigger: { kind: "system", correlationId: "chat-1:12" },
    });
    await vision.succeed();

    const activity = await getOverviewActivity();
    expect(activity.handled).toBe(1);
    expect(activity.images).toBe(1);
  });
});
