import type { TurnLifecycleEvent } from "@assistant-hub/contracts";
import { describe, expect, it } from "vitest";

import { ThreadTurns } from "./turns";

/**
 * What a thread shows while the core is working. The rules that matter are
 * the ones a user would notice: progress only pings the dashboard when it
 * actually changed, a settle clears it, and a turn nobody ever settles stops
 * claiming to be running instead of spinning forever.
 */

const THREAD = "thread-1";

function lifecycle(
  phase: TurnLifecycleEvent["phase"],
  options: { messageId?: string; activity?: string } = {},
): TurnLifecycleEvent {
  return {
    v: 1,
    eventId: `evt-${phase}-${options.activity ?? "none"}`,
    occurredAt: new Date().toISOString(),
    correlationId: `${THREAD}:1:assistant-1`,
    type: "turn.lifecycle",
    source: "chat",
    assistantId: "assistant-1",
    chatRef: `chat:thread:${THREAD}`,
    sourceMessageId: options.messageId ?? "1",
    phase,
    ...(options.activity ? { activity: options.activity } : {}),
  };
}

describe("ThreadTurns", () => {
  it("starts on accepted and reports what the turn is doing", () => {
    const turns = new ThreadTurns();
    expect(turns.apply(THREAD, lifecycle("accepted"))).toBe(true);
    expect(turns.get(THREAD)).toMatchObject({ sourceMessageId: "1", activity: null });

    expect(turns.apply(THREAD, lifecycle("progress", { activity: "browse_web" }))).toBe(true);
    expect(turns.get(THREAD)).toMatchObject({ activity: "browse_web" });
  });

  it("does not ping the dashboard for a repeat of what it already shows", () => {
    const turns = new ThreadTurns();
    turns.apply(THREAD, lifecycle("progress", { activity: "browse_web" }));
    expect(turns.apply(THREAD, lifecycle("progress", { activity: "browse_web" }))).toBe(false);
  });

  it("keeps the start time across a turn's progress, and resets it for the next turn", () => {
    let now = new Date("2026-08-27T10:00:00Z");
    const turns = new ThreadTurns(() => now);
    turns.apply(THREAD, lifecycle("accepted"));
    now = new Date("2026-08-27T10:00:05Z");
    turns.apply(THREAD, lifecycle("progress", { activity: "memory_search" }));
    expect(turns.get(THREAD)?.since.toISOString()).toBe("2026-08-27T10:00:00.000Z");

    turns.apply(THREAD, lifecycle("accepted", { messageId: "2" }));
    expect(turns.get(THREAD)?.since.toISOString()).toBe("2026-08-27T10:00:05.000Z");
  });

  it("clears on settle", () => {
    const turns = new ThreadTurns();
    turns.apply(THREAD, lifecycle("accepted"));
    expect(turns.apply(THREAD, lifecycle("settled"))).toBe(true);
    expect(turns.get(THREAD)).toBeNull();
    // Nothing to clear the second time — and nothing to ping about.
    expect(turns.apply(THREAD, lifecycle("settled"))).toBe(false);
  });

  it("stops claiming a turn that was never settled", () => {
    let now = new Date("2026-08-27T10:00:00Z");
    const turns = new ThreadTurns(() => now);
    turns.apply(THREAD, lifecycle("accepted"));
    now = new Date("2026-08-27T10:09:00Z");
    expect(turns.get(THREAD)).not.toBeNull();
    now = new Date("2026-08-27T10:11:00Z");
    expect(turns.get(THREAD)).toBeNull();
  });
});
