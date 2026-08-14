import { describe, expect, it } from "vitest";

import { chanceOutcome, MAX_PERCENT, ROLL_STEPS } from "./chance";

/**
 * The chance roll's arithmetic. The boundaries are the whole test: a task written
 * as "0%" that fires anyway, or "100%" that occasionally does not, is a bug the
 * operator can only catch by watching a chat for a week.
 */

describe("chanceOutcome", () => {
  it("hits when the roll is under the percentage and misses when it is over", () => {
    expect(chanceOutcome(30, 17.4).hit).toBe(true);
    expect(chanceOutcome(30, 74.1).hit).toBe(false);
  });

  it("treats the threshold itself as a miss", () => {
    // The roll is drawn from [0, 100), so `roll < percent` is what makes 0 and
    // 100 come out right; `<=` would let 0% fire on a roll of exactly 0.
    expect(chanceOutcome(30, 30).hit).toBe(false);
  });

  it("never hits at 0 and always hits at 100, including at the extreme rolls", () => {
    const lowest = 0;
    const highest = (ROLL_STEPS - 1) / (ROLL_STEPS / MAX_PERCENT);

    expect(highest).toBeLessThan(MAX_PERCENT);
    expect(chanceOutcome(0, lowest).hit).toBe(false);
    expect(chanceOutcome(0, highest).hit).toBe(false);
    expect(chanceOutcome(100, lowest).hit).toBe(true);
    expect(chanceOutcome(100, highest).hit).toBe(true);
  });

  it("shows both numbers in the verdict, so a trace can be checked afterwards", () => {
    // The verdict is the only record of why a turn went the way it did — "MISS"
    // on its own is unfalsifiable when someone asks a week later.
    expect(chanceOutcome(30, 74.11).text).toBe("MISS (rolled 74.11 >= 30)");
    expect(chanceOutcome(30, 12.34).text).toBe("HIT (rolled 12.34 < 30)");
  });

  it("prints the roll it compared, with no rounding in between", () => {
    // Rounding for display is what produced "rolled 100 < 100" from a draw of
    // 99.999 — a verdict contradicting itself. The number shown is the number
    // compared, so that cannot recur.
    const outcome = chanceOutcome(50, 99.99);
    expect(outcome.roll).toBe(99.99);
    expect(outcome.text).toContain("99.99");
  });

  it("accepts a fractional percentage", () => {
    expect(chanceOutcome(0.5, 0.4).hit).toBe(true);
    expect(chanceOutcome(0.5, 0.6).hit).toBe(false);
  });
});
