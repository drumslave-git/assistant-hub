import { describe, expect, it } from "vitest";

import { isDailyRunDue, todaysRunInstant } from "@/server/jobs/daily-due";

describe("todaysRunInstant", () => {
  it("resolves the local HH:MM to a UTC instant in the given zone", () => {
    // Kyiv is UTC+3 in July → 04:00 local = 01:00Z.
    const now = new Date("2026-07-14T10:00:00Z");
    expect(todaysRunInstant("04:00", now, "Europe/Kyiv")?.toISOString()).toBe(
      "2026-07-14T01:00:00.000Z",
    );
    expect(todaysRunInstant("04:00", now, "UTC")?.toISOString()).toBe("2026-07-14T04:00:00.000Z");
  });

  it("returns null for an unparseable time", () => {
    expect(todaysRunInstant("25:00", new Date(), "UTC")).toBeNull();
    expect(todaysRunInstant("not-a-time", new Date(), "UTC")).toBeNull();
  });
});

describe("isDailyRunDue", () => {
  const timeZone = "UTC";
  const timeOfDay = "04:00";

  it("is not due before today's run time", () => {
    expect(
      isDailyRunDue({ timeOfDay, timeZone, now: new Date("2026-07-14T03:59:00Z"), lastRunAt: null }),
    ).toBe(false);
  });

  it("is due once the run time passes and no run has happened since", () => {
    expect(
      isDailyRunDue({ timeOfDay, timeZone, now: new Date("2026-07-14T04:01:00Z"), lastRunAt: null }),
    ).toBe(true);
    expect(
      isDailyRunDue({
        timeOfDay,
        timeZone,
        now: new Date("2026-07-14T10:00:00Z"),
        lastRunAt: new Date("2026-07-13T04:00:30Z"), // yesterday's run
      }),
    ).toBe(true);
  });

  it("is not due again after today's run", () => {
    expect(
      isDailyRunDue({
        timeOfDay,
        timeZone,
        now: new Date("2026-07-14T10:00:00Z"),
        lastRunAt: new Date("2026-07-14T04:00:30Z"),
      }),
    ).toBe(false);
  });

  it("is never due for an invalid run time", () => {
    expect(
      isDailyRunDue({ timeOfDay: "bad", timeZone, now: new Date(), lastRunAt: null }),
    ).toBe(false);
  });
});
