/**
 * Shared, deterministic formatters for operator-facing timestamps and durations.
 *
 * The timestamp formatters themselves live in `@assistant-hub-swarm/ui` beside the
 * `<Timestamp>` component, so app-contributed dashboard UI renders instants
 * the same way the shell does; they are re-exported here because that is where
 * this app has always imported them from. Prefer the component over calling
 * them directly.
 */

export { formatTime, formatTimestamp } from "@assistant-hub-swarm/ui";

/** Elapsed time between two ISO instants, human-readable (`842ms`, `3.2s`, `1m 4s`). */
export function formatDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
