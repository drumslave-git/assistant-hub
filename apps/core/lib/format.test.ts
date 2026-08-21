import { describe, expect, it } from "vitest";

import { formatDuration, formatTime, formatTimestamp } from "./format";

describe("formatTimestamp", () => {
  it("formats an ISO instant in the configured timezone", () => {
    expect(formatTimestamp("2026-07-11T14:23:05.123Z", "UTC")).toBe("2026-07-11 14:23:05 UTC");
  });

  it("shifts the wall clock (and the date) into the configured zone", () => {
    // 23:30 UTC is already the next day in Tokyo (+09:00).
    expect(formatTimestamp("2026-07-11T23:30:00.000Z", "Asia/Tokyo")).toBe(
      "2026-07-12 08:30:00 GMT+9",
    );
  });

  it("uses a 24-hour clock across midnight", () => {
    expect(formatTimestamp("2026-07-11T00:00:00.000Z", "UTC")).toBe("2026-07-11 00:00:00 UTC");
  });

  it("falls back to UTC when the zone is unknown to the runtime", () => {
    expect(formatTimestamp("2026-07-11T14:23:05.000Z", "Not/AZone")).toBe(
      "2026-07-11 14:23:05 UTC",
    );
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatTimestamp("not-a-date", "UTC")).toBe("not-a-date");
  });
});

describe("formatTime", () => {
  it("formats time-of-day in the configured timezone", () => {
    expect(formatTime("2026-07-11T09:05:07.000Z", "UTC")).toBe("09:05:07");
    expect(formatTime("2026-07-11T09:05:07.000Z", "Asia/Tokyo")).toBe("18:05:07");
  });
});

describe("formatDuration", () => {
  it("returns null when there is no end time", () => {
    expect(formatDuration("2026-07-11T14:23:05.000Z", null)).toBeNull();
  });

  it("formats sub-second, seconds, and minute ranges", () => {
    const start = "2026-07-11T14:00:00.000Z";
    expect(formatDuration(start, "2026-07-11T14:00:00.842Z")).toBe("842ms");
    expect(formatDuration(start, "2026-07-11T14:00:03.200Z")).toBe("3.2s");
    expect(formatDuration(start, "2026-07-11T14:01:04.000Z")).toBe("1m 4s");
  });

  it("returns null for a negative span", () => {
    expect(
      formatDuration("2026-07-11T14:00:05.000Z", "2026-07-11T14:00:00.000Z"),
    ).toBeNull();
  });
});
