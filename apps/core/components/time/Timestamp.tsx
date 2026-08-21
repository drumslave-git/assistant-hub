"use client";

import { formatTime, formatTimestamp } from "@/lib/format";

import { useTimezone } from "./TimezoneProvider";

/**
 * The one way to render an instant in the dashboard. Formats in the operator's
 * configured timezone (never the viewer's local zone, never hardcoded UTC) and
 * emits a semantic `<time>` carrying the original ISO instant.
 *
 * Renders from Server *and* Client Components alike — the zone comes from
 * {@link TimezoneProvider} in the root layout.
 */
export function Timestamp({
  iso,
  timeOnly = false,
  fallback = "—",
  className,
}: {
  /** ISO instant. `null`/`undefined` renders `fallback` (e.g. "never run"). */
  iso: string | null | undefined;
  /** Time of day only (`HH:mm:ss`), for dense timelines where the date repeats. */
  timeOnly?: boolean;
  fallback?: string;
  className?: string;
}) {
  const timeZone = useTimezone();
  if (!iso) return <span className={className}>{fallback}</span>;
  return (
    <time dateTime={iso} className={className}>
      {timeOnly ? formatTime(iso, timeZone) : formatTimestamp(iso, timeZone)}
    </time>
  );
}
