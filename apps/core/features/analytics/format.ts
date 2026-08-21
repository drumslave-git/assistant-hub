/**
 * Small client-safe number/label formatters for the analytics dashboard.
 */

/** Compact number (`1234` → `1.2k`, `2_500_000` → `2.5M`). */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return `${trim(n / 1000)}k`;
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Grouped integer (`1234567` → `1,234,567`). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Latency in ms as `820 ms` or `3.4 s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${trim(ms / 1000)} s`;
}

/** A 0–1 ratio as a whole-number percentage. */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
