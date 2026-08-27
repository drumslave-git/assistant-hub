"use client";

import { createContext, useContext, type ReactNode } from "react";

import { formatTime, formatTimestamp } from "./time";

/**
 * The one way to render an instant in the dashboard — the shell's pages and
 * every app-contributed view alike. Formats in the operator's configured
 * timezone (never the viewer's local zone, never hardcoded UTC) and emits a
 * semantic `<time>` carrying the original ISO instant.
 *
 * Renders from Server *and* Client Components alike — the zone comes from
 * {@link TimezoneProvider}, seeded once per request in the shell's root
 * layout, so nothing has to thread a zone through props (and no component
 * gets to take one).
 */

const TimezoneContext = createContext<string>("UTC");

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: ReactNode;
}) {
  return <TimezoneContext.Provider value={timezone}>{children}</TimezoneContext.Provider>;
}

/** The configured IANA timezone (`UTC` until settings say otherwise). */
export function useTimezone(): string {
  return useContext(TimezoneContext);
}

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
