import { describe, expect, it } from "vitest";

import { buildRunOutcomeMessages, parseRunOutcomeVerdict } from "./outcome";

const REPORT =
  "I tried to download the track with browser_download_media three times, " +
  "but every attempt failed with a network error. The file could not be downloaded.";

describe("buildRunOutcomeMessages", () => {
  it("carries the goal and the report", () => {
    const messages = buildRunOutcomeMessages({ goal: "download the track", report: REPORT });
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("download the track");
    expect(messages[1].content).toContain("every attempt failed");
  });
});

describe("parseRunOutcomeVerdict", () => {
  it("confirms a failure whose citation really occurs in the report", () => {
    const verdict = parseRunOutcomeVerdict(
      '{"outcome": "failed", "quote": "The file could not be downloaded."}',
      { report: REPORT },
    );
    expect(verdict.goalFailed).toBe(true);
    expect(verdict.outcome).toBe("failed");
    expect(verdict.quote).toBe("The file could not be downloaded.");
  });

  it("matches the citation case-insensitively (weak models re-case)", () => {
    const verdict = parseRunOutcomeVerdict(
      '{"outcome": "failed", "quote": "the file could not be downloaded."}',
      { report: REPORT },
    );
    expect(verdict.goalFailed).toBe(true);
  });

  it("abstains on a failure verdict with no quote", () => {
    const verdict = parseRunOutcomeVerdict('{"outcome": "failed", "quote": null}', {
      report: REPORT,
    });
    expect(verdict.goalFailed).toBe(false);
    expect(verdict.reason).toContain("without quoting");
  });

  it("abstains when the quote does not occur in the report (bluffed citation)", () => {
    const verdict = parseRunOutcomeVerdict(
      '{"outcome": "failed", "quote": "download is impossible"}',
      { report: REPORT },
    );
    expect(verdict.goalFailed).toBe(false);
    expect(verdict.reason).toContain("does not occur");
  });

  it("passes an achieved report through without needing a quote", () => {
    const verdict = parseRunOutcomeVerdict('{"outcome": "achieved", "quote": null}', {
      report: "Here is the file you asked for.",
    });
    expect(verdict.goalFailed).toBe(false);
    expect(verdict.outcome).toBe("achieved");
  });

  it("abstains on an unclear verdict and on unreadable answers", () => {
    expect(
      parseRunOutcomeVerdict('{"outcome": "unclear", "quote": null}', { report: REPORT })
        .goalFailed,
    ).toBe(false);
    expect(parseRunOutcomeVerdict("no json here", { report: REPORT }).goalFailed).toBe(false);
    expect(
      parseRunOutcomeVerdict('{"outcome": "exploded"}', { report: REPORT }).goalFailed,
    ).toBe(false);
  });

  it("tolerates a verdict wrapped in prose or fences", () => {
    const verdict = parseRunOutcomeVerdict(
      'Sure! ```json\n{"outcome": "failed", "quote": "every attempt failed"}\n``` hope that helps',
      { report: REPORT },
    );
    expect(verdict.goalFailed).toBe(true);
  });
});
