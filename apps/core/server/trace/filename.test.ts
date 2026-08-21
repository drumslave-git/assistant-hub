import { describe, expect, it } from "vitest";

import { traceBundleFilename, traceListBundleFilename } from "./filename";

/**
 * Download names, pinned: a saved bundle must say what it holds — feature,
 * action, and the start time in the operator's timezone — instead of a bare
 * uuid (operator report, 2026-08-15).
 */

describe("traceBundleFilename", () => {
  const trace = {
    feature: "memory-extraction",
    action: "extract",
    startedAt: "2026-08-15T01:01:29.947Z",
    id: "eb0094f0-341c-40ee-9a40-4c348c83ad35",
  };

  it("names the file by feature, action, local start time, and id prefix", () => {
    // 01:01 UTC is 04:01 in Kyiv (UTC+3 in August) — the same clock the
    // dashboard shows for this trace.
    expect(traceBundleFilename(trace, "Europe/Kyiv")).toBe(
      "trace-memory-extraction-extract-20260815-040129-eb0094f0.json",
    );
  });

  it("falls back to UTC on an unknown timezone instead of failing the download", () => {
    expect(traceBundleFilename(trace, "Not/AZone")).toBe(
      "trace-memory-extraction-extract-20260815-010129-eb0094f0.json",
    );
  });
});

describe("traceListBundleFilename", () => {
  it("names an unfiltered export 'all' with the export time", () => {
    expect(traceListBundleFilename({}, "2026-08-15T13:51:29.999Z", "UTC")).toBe(
      "traces-all-20260815-135129.json",
    );
  });

  it("carries every active facet, slug-safe", () => {
    expect(
      traceListBundleFilename(
        { feature: "bot-messaging", status: "error", correlationId: "-100123:16901" },
        "2026-08-15T13:51:29.999Z",
        "UTC",
      ),
    ).toBe("traces-bot-messaging-error-100123-16901-20260815-135129.json");
  });
});
