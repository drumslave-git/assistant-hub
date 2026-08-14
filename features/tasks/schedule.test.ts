import { describe, expect, it } from "vitest";

import {
  computeNextScheduleRun,
  computeNextTriggerRun,
  computeTimeoutRun,
  describeMinutes,
  describeTrigger,
  isValidTimezone,
  normalizeTimeOfDay,
  normalizeTrigger,
  normalizeWeekdays,
  parseRunDate,
  parseTimeOfDay,
  scheduleKindOf,
  zonedWallClockToUtc,
} from "./schedule";

describe("parseTimeOfDay / normalizeTimeOfDay", () => {
  it("parses valid times and rejects bad ones", () => {
    expect(parseTimeOfDay("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("noon")).toBeNull();
  });

  it("normalizes to zero-padded HH:MM", () => {
    expect(normalizeTimeOfDay("9:5")).toBeNull(); // minutes must be 2 digits
    expect(normalizeTimeOfDay("9:05")).toBe("09:05");
    expect(normalizeTimeOfDay("07:00")).toBe("07:00");
  });
});

describe("parseRunDate / normalizeWeekdays", () => {
  it("parses ISO dates", () => {
    expect(parseRunDate("2026-07-14")).toEqual({ year: 2026, month: 7, day: 14 });
    expect(parseRunDate("2026-13-01")).toBeNull();
    expect(parseRunDate("14/07/2026")).toBeNull();
  });

  it("sorts, dedupes, and clamps weekdays", () => {
    expect(normalizeWeekdays([3, 1, 1, 5, 9, -1])).toEqual([1, 3, 5]);
    expect(normalizeWeekdays([])).toEqual([]);
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
  });
});

describe("zonedWallClockToUtc", () => {
  it("converts a wall-clock time to the correct UTC instant", () => {
    // 12:00 in UTC is 12:00Z.
    expect(zonedWallClockToUtc(2026, 1, 15, 12, 0, "UTC").toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    // Berlin in January is UTC+1, so 12:00 local = 11:00Z.
    expect(zonedWallClockToUtc(2026, 1, 15, 12, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-01-15T11:00:00.000Z",
    );
    // Berlin in July is UTC+2 (DST), so 12:00 local = 10:00Z.
    expect(zonedWallClockToUtc(2026, 7, 15, 12, 0, "Europe/Berlin").toISOString()).toBe(
      "2026-07-15T10:00:00.000Z",
    );
  });
});

describe("computeNextScheduleRun", () => {
  const from = new Date("2026-07-14T08:30:00.000Z"); // a Tuesday

  it("once: future date fires, past date does not", () => {
    expect(
      computeNextScheduleRun(
        { scheduleKind: "once", timeOfDay: "12:00", runDate: "2026-07-14" },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-14T12:00:00.000Z");
    expect(
      computeNextScheduleRun(
        { scheduleKind: "once", timeOfDay: "08:00", runDate: "2026-07-14" },
        from,
        "UTC",
      ),
    ).toBeNull();
  });

  it("daily: today if still ahead, else tomorrow", () => {
    expect(
      computeNextScheduleRun({ scheduleKind: "daily", timeOfDay: "12:00" }, from, "UTC")
        ?.toISOString(),
    ).toBe("2026-07-14T12:00:00.000Z");
    expect(
      computeNextScheduleRun({ scheduleKind: "daily", timeOfDay: "08:00" }, from, "UTC")
        ?.toISOString(),
    ).toBe("2026-07-15T08:00:00.000Z");
  });

  it("weekly: next matching weekday", () => {
    // from is Tuesday (2). Ask for Wednesday (3) → next day.
    expect(
      computeNextScheduleRun(
        { scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [3] },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-15T09:00:00.000Z");
    // Ask for Tuesday (2) but the time already passed today → next Tuesday.
    expect(
      computeNextScheduleRun(
        { scheduleKind: "weekly", timeOfDay: "08:00", weekdays: [2] },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-21T08:00:00.000Z");
    // No weekdays → never.
    expect(
      computeNextScheduleRun(
        { scheduleKind: "weekly", timeOfDay: "09:00", weekdays: [] },
        from,
        "UTC",
      ),
    ).toBeNull();
  });

  it("returns null for an unparseable time", () => {
    expect(computeNextScheduleRun({ scheduleKind: "daily", timeOfDay: "??" }, from, "UTC")).toBeNull();
  });
});

describe("computeNextTriggerRun", () => {
  const from = new Date("2026-07-14T08:30:00.000Z");

  it("interval: the period after the settled fire", () => {
    expect(
      computeNextTriggerRun({ triggerKind: "interval", everyMinutes: 10 }, from, "UTC")
        ?.toISOString(),
    ).toBe("2026-07-14T08:40:00.000Z");
    // Below the floor → never (a row that snuck in cannot busy-loop).
    expect(computeNextTriggerRun({ triggerKind: "interval", everyMinutes: 0 }, from, "UTC")).toBeNull();
  });

  it("timeout: spent after its single instant (creation computed it)", () => {
    expect(computeNextTriggerRun({ triggerKind: "timeout", }, from, "UTC")).toBeNull();
    expect(computeTimeoutRun(60, from).toISOString()).toBe("2026-07-14T09:30:00.000Z");
  });

  it("schedule: delegates to the calendar math via the derived kind", () => {
    expect(
      computeNextTriggerRun(
        { triggerKind: "schedule", timeOfDay: "12:00" },
        from,
        "UTC",
      )?.toISOString(),
    ).toBe("2026-07-14T12:00:00.000Z");
    expect(
      computeNextTriggerRun(
        { triggerKind: "schedule", timeOfDay: "08:00", runDate: "2026-07-13" },
        from,
        "UTC",
      ),
    ).toBeNull();
  });

  it("prompt kinds are never timed", () => {
    expect(computeNextTriggerRun({ triggerKind: "message" }, from, "UTC")).toBeNull();
    expect(computeNextTriggerRun({ triggerKind: "on-reply" }, from, "UTC")).toBeNull();
  });
});

describe("scheduleKindOf", () => {
  it("derives the kind from which fields are set", () => {
    expect(scheduleKindOf({ runDate: "2026-12-31" })).toBe("once");
    expect(scheduleKindOf({ weekdays: [1, 3] })).toBe("weekly");
    expect(scheduleKindOf({})).toBe("daily");
  });
});

describe("describeTrigger / describeMinutes", () => {
  const base = {
    everyMinutes: null,
    delayMinutes: null,
    timeOfDay: null,
    weekdays: null,
    runDate: null,
  };

  it("renders human summaries for every kind", () => {
    expect(describeTrigger({ ...base, triggerKind: "message" })).toBe("on matching messages");
    expect(describeTrigger({ ...base, triggerKind: "on-reply" })).toBe("shapes every reply");
    expect(describeTrigger({ ...base, triggerKind: "interval", everyMinutes: 10 })).toBe(
      "every 10m",
    );
    expect(describeTrigger({ ...base, triggerKind: "timeout", delayMinutes: 120 })).toBe(
      "once, 2h after creation",
    );
    expect(describeTrigger({ ...base, triggerKind: "schedule", timeOfDay: "17:00" })).toBe(
      "every day at 17:00",
    );
    expect(
      describeTrigger({ ...base, triggerKind: "schedule", timeOfDay: "9:00", weekdays: [1, 3, 5] }),
    ).toBe("every Mon, Wed, Fri at 09:00");
    expect(
      describeTrigger({
        ...base,
        triggerKind: "schedule",
        timeOfDay: "12:30",
        runDate: "2026-12-31",
      }),
    ).toBe("once on 2026-12-31 at 12:30");
  });

  it("picks the largest whole unit for a period", () => {
    expect(describeMinutes(45)).toBe("45m");
    expect(describeMinutes(180)).toBe("3h");
    expect(describeMinutes(2880)).toBe("2d");
  });
});

describe("normalizeTrigger", () => {
  it("normalizes each kind and nulls what the kind does not use", () => {
    expect(normalizeTrigger({ triggerKind: "message", everyMinutes: 10 })).toEqual({
      triggerKind: "message",
      everyMinutes: null,
      delayMinutes: null,
      timeOfDay: null,
      weekdays: null,
      runDate: null,
    });
    expect(normalizeTrigger({ triggerKind: "interval", everyMinutes: 10 })).toMatchObject({
      triggerKind: "interval",
      everyMinutes: 10,
      delayMinutes: null,
    });
    expect(normalizeTrigger({ triggerKind: "timeout", delayMinutes: 60 })).toMatchObject({
      triggerKind: "timeout",
      delayMinutes: 60,
    });
    expect(
      normalizeTrigger({ triggerKind: "schedule", scheduleKind: "daily", timeOfDay: "9:00" }),
    ).toMatchObject({ triggerKind: "schedule", timeOfDay: "09:00", weekdays: null, runDate: null });
    expect(
      normalizeTrigger({
        triggerKind: "schedule",
        scheduleKind: "weekly",
        timeOfDay: "09:00",
        weekdays: [5, 1, 1],
      }),
    ).toMatchObject({ timeOfDay: "09:00", weekdays: [1, 5] });
  });

  it("rejects bad input with a user-facing message", () => {
    expect(() => normalizeTrigger({ triggerKind: "interval" })).toThrow(/every_minutes/);
    expect(() => normalizeTrigger({ triggerKind: "interval", everyMinutes: 0 })).toThrow(
      /every_minutes/,
    );
    expect(() => normalizeTrigger({ triggerKind: "timeout", delayMinutes: 2.5 })).toThrow(
      /delay_minutes/,
    );
    expect(() =>
      normalizeTrigger({ triggerKind: "schedule", scheduleKind: "weekly", timeOfDay: "09:00" }),
    ).toThrow(/weekday/);
    expect(() =>
      normalizeTrigger({ triggerKind: "schedule", scheduleKind: "once", timeOfDay: "09:00" }),
    ).toThrow(/date/);
    expect(() => normalizeTrigger({ triggerKind: "schedule", timeOfDay: "bad" })).toThrow(/HH:MM/);
  });
});
