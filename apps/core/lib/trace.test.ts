import { describe, expect, it } from "vitest";

import { debugFilterHref, newRunCorrelationId } from "./trace";

describe("debugFilterHref", () => {
  it("builds the canonical Debug URL for a facet set", () => {
    expect(debugFilterHref({})).toBe("/debug");
    expect(debugFilterHref({ feature: "memory-extraction", status: "error" })).toBe(
      "/debug?feature=memory-extraction&status=error",
    );
    expect(debugFilterHref({ triggerKind: "cron", actor: "memory-extraction" })).toBe(
      "/debug?triggerKind=cron&actor=memory-extraction",
    );
  });

  it("URL-encodes facet values (correlations carry colons)", () => {
    expect(debugFilterHref({ correlationId: "312973896:600" })).toBe(
      "/debug?correlationId=312973896%3A600",
    );
  });

  it("targets a scoped base path when given one", () => {
    expect(debugFilterHref({ status: "error" }, "/history/debug")).toBe(
      "/history/debug?status=error",
    );
  });
});

describe("newRunCorrelationId", () => {
  it("stamps the job name and start time, readable at a glance", () => {
    expect(newRunCorrelationId("memory", new Date("2026-08-15T01:01:29.947Z"))).toBe(
      "memory:20260815-010129",
    );
  });
});
