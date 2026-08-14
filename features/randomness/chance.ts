/**
 * The chance roll, as pure arithmetic.
 *
 * Separated from the MCP handler so the interesting half — where the boundaries
 * fall, how the verdict reads — is testable without stubbing a random source.
 * The handler's only job is to produce the roll.
 */

/** Percentages are bounded at both ends; anything outside is a caller error. */
export const MIN_PERCENT = 0;
export const MAX_PERCENT = 100;

/**
 * Steps in a roll: hundredths of a percent, which is finer than any prompt and
 * is also exactly what the verdict prints.
 *
 * Those being the same number is the point. An earlier version drew at a much
 * finer resolution and rounded for display, which could print `rolled 100 < 100`
 * from a draw of 99.999 — a verdict that contradicts itself, on the one tool
 * whose output is otherwise unverifiable. Drawing at display precision means the
 * number shown *is* the number compared.
 */
export const ROLL_STEPS = 10_000;

export interface ChanceOutcome {
  hit: boolean;
  /** The percentage that was asked for. */
  percent: number;
  /** The roll, on the same 0–100 scale. Already at display precision. */
  roll: number;
  /** The verdict, as the model reads it. */
  text: string;
}

/**
 * Decide one roll against a percentage.
 *
 * The comparison is `roll < percent` over a roll drawn uniformly from **[0, 100)**,
 * which is what makes the edges correct: at 0 nothing can be below it, and at 100
 * everything is. A `<=` here would make "0%" fire once in a million.
 *
 * The verdict text shows the numbers rather than only the word, so the trace of a
 * turn says *why* it went that way — "MISS" alone is unfalsifiable months later,
 * and this is the one tool whose whole output is otherwise unverifiable.
 */
export function chanceOutcome(percent: number, roll: number): ChanceOutcome {
  const hit = roll < percent;
  return {
    hit,
    percent,
    roll,
    text: hit ? `HIT (rolled ${roll} < ${percent})` : `MISS (rolled ${roll} >= ${percent})`,
  };
}
