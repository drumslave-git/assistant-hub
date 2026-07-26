import { describe, expect, it } from "vitest";

import type { EngineStat } from "../types";
import { rankEngines, successRate } from "./engine-stats";

/**
 * Unit coverage for the ranking itself — the pure half of the scoreboard. What
 * matters here is the *order* the cascade will use, and that it takes real
 * evidence to change it.
 */

/** A stat row with only the fields the ranking reads. */
function stat(engine: string, successes: number, failures: number): EngineStat {
  return {
    engine,
    successes,
    failures,
    successRate: successRate({ successes, failures }),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

const CONFIGURED = ["DuckDuckGo", "Google", "Bing"];

describe("successRate", () => {
  it("scores an untried source at even odds", () => {
    expect(successRate({ successes: 0, failures: 0 })).toBe(0.5);
  });

  it("ranks a long good record above a short one", () => {
    expect(successRate({ successes: 20, failures: 0 })).toBeGreaterThan(
      successRate({ successes: 1, failures: 0 }),
    );
  });

  it("never reaches certainty in either direction", () => {
    expect(successRate({ successes: 500, failures: 0 })).toBeLessThan(1);
    expect(successRate({ successes: 0, failures: 500 })).toBeGreaterThan(0);
  });
});

describe("rankEngines", () => {
  it("keeps the configured order when nothing has been measured", () => {
    expect(rankEngines(CONFIGURED, [])).toEqual(CONFIGURED);
  });

  it("promotes the engine that actually answers", () => {
    // The live picture on 2026-07-26: only Bing returns results.
    const stats = [
      stat("DuckDuckGo", 0, 12),
      stat("Google", 0, 12),
      stat("Bing", 12, 0),
    ];
    expect(rankEngines(CONFIGURED, stats)).toEqual(["Bing", "DuckDuckGo", "Google"]);
  });

  it("keeps an untried engine ahead of a proven-bad one", () => {
    // A newly added engine must get a real chance, not start at the back.
    const stats = [stat("DuckDuckGo", 0, 30), stat("Bing", 30, 0)];
    expect(rankEngines(CONFIGURED, stats)).toEqual(["Bing", "Google", "DuckDuckGo"]);
  });

  it("does not let one lucky hit outrank a long record", () => {
    const stats = [stat("DuckDuckGo", 1, 0), stat("Bing", 40, 2)];
    expect(rankEngines(CONFIGURED, stats)[0]).toBe("Bing");
  });

  it("lets a recovering engine climb back as evidence accumulates", () => {
    // Post-decay: the bad history has been halved away and it is winning again.
    const recovering = [stat("DuckDuckGo", 9, 3), stat("Google", 0, 6), stat("Bing", 6, 6)];
    expect(rankEngines(CONFIGURED, recovering)).toEqual(["DuckDuckGo", "Bing", "Google"]);
  });

  it("breaks ties on the configured order, not on name or chance", () => {
    const stats = [stat("Bing", 5, 5), stat("Google", 5, 5), stat("DuckDuckGo", 5, 5)];
    expect(rankEngines(CONFIGURED, stats)).toEqual(CONFIGURED);
  });

  it("ignores stats for sources that are not in the cascade", () => {
    const stats = [stat("Tavily", 99, 0), stat("Bing", 3, 0)];
    expect(rankEngines(CONFIGURED, stats)).toEqual(["Bing", "DuckDuckGo", "Google"]);
  });
});
