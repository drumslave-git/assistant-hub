/**
 * Pure mood helpers shared by the insight job (parsing/clamping model scores) and
 * the dashboard (labelling an aggregate score). No imports — client-safe.
 */

/** Clamp any number to an integer mood score in [0, 100]. */
export function clampMoodScore(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A short human label for a mood score, used for aggregate (multi-day) moods. */
export function moodLabelForScore(score: number): string {
  const s = clampMoodScore(score);
  if (s >= 80) return "very positive";
  if (s >= 60) return "positive";
  if (s >= 45) return "neutral";
  if (s >= 25) return "tense";
  return "negative";
}
