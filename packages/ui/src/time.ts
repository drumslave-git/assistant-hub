/**
 * Deterministic formatters for operator-facing timestamps.
 *
 * Timestamps render in the operator's configured IANA timezone (Settings), not
 * the viewer's local zone: the same instant reads identically on the server and
 * the client — no hydration drift — and matches the wall-clock times scheduled
 * tasks actually fire at. Prefer the `<Timestamp>` component over calling these
 * directly; it reads the zone from {@link TimezoneProvider}.
 */

/** Intl formatters are expensive to construct; one per zone is enough. */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Cached formatter for `timeZone`, falling back to UTC when the zone is unknown
 * to the runtime (a stale or mistyped setting must not break every page).
 */
function getFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cached = cache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  cache.set(timeZone, formatter);
  return formatter;
}

/** Pull the parts we need out of a formatted instant, keyed by part type. */
function partsOf(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

/**
 * ISO instant → `YYYY-MM-DD HH:mm:ss <zone>` in `timeZone` (e.g.
 * `2026-07-11 16:23:05 GMT+2`). Returns the input unchanged if unparseable.
 */
export function formatTimestamp(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = partsOf(
    getFormatter(dateTimeFormatters, timeZone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }),
    d,
  );
  return (
    `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`
  );
}

/**
 * Time only (`HH:mm:ss`) in `timeZone`, for dense event timelines where the date
 * is redundant.
 */
export function formatTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = partsOf(
    getFormatter(timeFormatters, timeZone, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    d,
  );
  return `${p.hour}:${p.minute}:${p.second}`;
}
