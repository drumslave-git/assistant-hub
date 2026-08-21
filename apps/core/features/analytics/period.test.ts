import { describe, expect, it } from "vitest";

import {
  addDaysToDateStr,
  anchorOfDate,
  bucketFormat,
  bucketKeyOfInstant,
  currentAnchor,
  densify,
  isAtOrAfterAnchor,
  periodRange,
  reanchor,
  stepAnchor,
  subBucketKeys,
  subUnitOf,
  truncUnit,
  weekBucketOf,
} from "./period";

describe("periodRange", () => {
  it("covers exactly one day, half-open", () => {
    const { startUtc, endUtc } = periodRange("day", "2026-07-15", "UTC");
    expect(startUtc.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("covers exactly one ISO week from its Monday", () => {
    const { startUtc, endUtc } = periodRange("week", "2026-07-13", "UTC");
    expect(startUtc.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("covers a whole month, wrapping the year at December", () => {
    expect(periodRange("month", "2026-02", "UTC").endUtc.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(periodRange("month", "2026-12", "UTC").endUtc.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("covers a whole year", () => {
    const { startUtc, endUtc } = periodRange("year", "2026", "UTC");
    expect(startUtc.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("bounds the period on the operator's wall clock, not UTC", () => {
    // New York is UTC-4 in July, so its 15th starts at 04:00Z.
    const { startUtc, endUtc } = periodRange("day", "2026-07-15", "America/New_York");
    expect(startUtc.toISOString()).toBe("2026-07-15T04:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-07-16T04:00:00.000Z");
  });

  it("gives adjacent periods a shared, non-overlapping boundary", () => {
    // The regression the whole rework exists for: an inclusive end would either
    // double-count the boundary instant or drop it.
    const a = periodRange("day", "2026-07-15", "UTC");
    const b = periodRange("day", "2026-07-16", "UTC");
    expect(a.endUtc.toISOString()).toBe(b.startUtc.toISOString());
  });

  it("opens `all` to the whole timeline", () => {
    const { startUtc, endUtc } = periodRange("all", "all", "UTC");
    expect(startUtc.getTime()).toBe(0);
    expect(endUtc.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("subBucketKeys", () => {
  it("plots a day as 24 hours", () => {
    const keys = subBucketKeys("day", "2026-07-15");
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe("2026-07-15 00");
    expect(keys[23]).toBe("2026-07-15 23");
  });

  it("plots a week as its 7 days", () => {
    expect(subBucketKeys("week", "2026-07-13")).toEqual([
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
    ]);
  });

  it("plots a month as its real day count, leap years included", () => {
    expect(subBucketKeys("month", "2026-02")).toHaveLength(28);
    expect(subBucketKeys("month", "2024-02")).toHaveLength(29);
    expect(subBucketKeys("month", "2026-07")).toHaveLength(31);
  });

  it("plots a year as 12 months", () => {
    const keys = subBucketKeys("year", "2026");
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2026-01");
    expect(keys[11]).toBe("2026-12");
  });

  it("has no axis for `all`", () => {
    expect(subBucketKeys("all", "all")).toEqual([]);
  });

  it("matches the sub-unit each period is charted at", () => {
    expect(subUnitOf("day")).toBe("hour");
    expect(subUnitOf("week")).toBe("day");
    expect(subUnitOf("month")).toBe("day");
    expect(subUnitOf("year")).toBe("month");
  });
});

describe("stepAnchor", () => {
  it("steps days and weeks across month boundaries", () => {
    expect(stepAnchor("day", "2026-07-01", -1)).toBe("2026-06-30");
    expect(stepAnchor("week", "2026-07-13", 1)).toBe("2026-07-20");
    expect(stepAnchor("week", "2026-07-13", -2)).toBe("2026-06-29");
  });

  it("steps months across the year boundary", () => {
    expect(stepAnchor("month", "2026-01", -1)).toBe("2025-12");
    expect(stepAnchor("month", "2026-12", 1)).toBe("2027-01");
  });

  it("steps years", () => {
    expect(stepAnchor("year", "2026", -3)).toBe("2023");
  });

  it("leaves `all` alone — it has no neighbours", () => {
    expect(stepAnchor("all", "all", 1)).toBe("all");
  });
});

describe("current period", () => {
  const now = new Date("2026-07-15T10:00:00Z");

  it("resolves the anchor each unit is currently in", () => {
    expect(currentAnchor("day", now, "UTC")).toBe("2026-07-15");
    expect(currentAnchor("week", now, "UTC")).toBe("2026-07-13");
    expect(currentAnchor("month", now, "UTC")).toBe("2026-07");
    expect(currentAnchor("year", now, "UTC")).toBe("2026");
  });

  it("blocks stepping past the current period", () => {
    // Compared against a supplied anchor, never the clock — the picker runs in the
    // browser, whose timezone is not the operator's.
    const today = currentAnchor("day", now, "UTC");
    expect(isAtOrAfterAnchor("day", "2026-07-15", today)).toBe(true);
    expect(isAtOrAfterAnchor("day", "2026-07-14", today)).toBe(false);

    const thisMonth = currentAnchor("month", now, "UTC");
    expect(isAtOrAfterAnchor("month", "2026-07", thisMonth)).toBe(true);
    expect(isAtOrAfterAnchor("month", "2026-06", thisMonth)).toBe(false);
  });
});

describe("reanchor", () => {
  it("carries the browsed position across a unit change", () => {
    expect(reanchor("day", "2026-03-09", "month", "2026-07-15")).toBe("2026-03");
    expect(reanchor("month", "2026-03", "year", "2026-07-15")).toBe("2026");
    expect(reanchor("year", "2023", "day", "2026-07-15")).toBe("2023-01-01");
  });

  it("maps a day onto the week containing it", () => {
    // 2026-07-15 is a Wednesday.
    expect(reanchor("day", "2026-07-15", "week", "2026-07-15")).toBe("2026-07-13");
  });

  it("falls back to today when coming from `all`, which has no position", () => {
    expect(reanchor("all", "all", "day", "2026-07-15")).toBe("2026-07-15");
  });
});

describe("week helpers", () => {
  it("weekBucketOf returns the Monday of a day", () => {
    expect(weekBucketOf("2026-07-15")).toBe("2026-07-13"); // Wed → Mon
    expect(weekBucketOf("2026-07-13")).toBe("2026-07-13"); // Mon → itself
    expect(weekBucketOf("2026-07-19")).toBe("2026-07-13"); // Sun → that Mon
  });

  it("addDaysToDateStr wraps months", () => {
    expect(addDaysToDateStr("2026-07-13", 6)).toBe("2026-07-19");
    expect(addDaysToDateStr("2026-07-29", 5)).toBe("2026-08-03");
  });

  it("anchorOfDate buckets a date at each unit", () => {
    expect(anchorOfDate("day", "2026-07-15")).toBe("2026-07-15");
    expect(anchorOfDate("week", "2026-07-15")).toBe("2026-07-13");
    expect(anchorOfDate("month", "2026-07-15")).toBe("2026-07");
    expect(anchorOfDate("year", "2026-07-15")).toBe("2026");
  });
});

describe("bucketKeyOfInstant", () => {
  it("matches the granularity forms", () => {
    const at = new Date("2026-07-15T10:00:00Z");
    expect(bucketKeyOfInstant(at, "hour", "UTC")).toBe("2026-07-15 10");
    expect(bucketKeyOfInstant(at, "day", "UTC")).toBe("2026-07-15");
    expect(bucketKeyOfInstant(at, "week", "UTC")).toBe("2026-07-13");
    expect(bucketKeyOfInstant(at, "month", "UTC")).toBe("2026-07");
    expect(bucketKeyOfInstant(at, "all", "UTC")).toBe("all");
  });

  it("buckets hours on the operator's wall clock", () => {
    const at = new Date("2026-07-15T02:00:00Z"); // 2026-07-14 22:00 in New York
    expect(bucketKeyOfInstant(at, "hour", "America/New_York")).toBe("2026-07-14 22");
  });
});

describe("sql/js format agreement", () => {
  it("pins the to_char format strings the repository groups by", () => {
    // These must stay identical to what Postgres produces for the same instant, or
    // values join onto a bucket axis they do not belong to and silently vanish.
    expect(bucketFormat("hour")).toBe("YYYY-MM-DD HH24");
    expect(bucketFormat("day")).toBe("YYYY-MM-DD");
    expect(bucketFormat("week")).toBe("YYYY-MM-DD");
    expect(bucketFormat("month")).toBe("YYYY-MM");
    expect(bucketFormat("year")).toBe("YYYY");
    expect(truncUnit("hour")).toBe("hour");
    expect(truncUnit("week")).toBe("week");
    expect(truncUnit("all")).toBeNull();
  });
});

describe("densify", () => {
  it("fills gaps with zero and aligns to the key axis", () => {
    expect(densify(["a", "b", "c"], new Map([["a", 5], ["c", 9]]))).toEqual([5, 0, 9]);
  });
});
