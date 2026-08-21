import type { Trace } from "@/lib/trace";

import type { TraceQuery } from "./service";

/**
 * Download filenames for trace bundles — what a saved file is identifiable by
 * once it sits in a Downloads folder next to ten others. `trace-<uuid>.json`
 * said nothing (operator report, 2026-08-15); the name now carries the feature,
 * the action, the local start time, and enough of the id to find the trace
 * again. Pure (timezone passed in) so the format is unit-testable; the routes
 * read the operator timezone, matching how every rendered time is shown.
 */

/** Filename-safe slug: lowercase, `[a-z0-9-]` only, runs collapsed. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

/** `YYYYMMDD-HHmmss` in the given timezone; falls back to UTC on a bad zone. */
function stampInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
  } catch {
    return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  }
}

/** `trace-<feature>-<action>-<local start>-<id8>.json` for a single trace. */
export function traceBundleFilename(
  trace: Pick<Trace, "feature" | "action" | "startedAt" | "id">,
  timeZone: string,
): string {
  const stamp = stampInZone(trace.startedAt, timeZone);
  return `trace-${slug(trace.feature)}-${slug(trace.action)}-${stamp}-${trace.id.slice(0, 8)}.json`;
}

/**
 * `traces-<facets>-<local export time>.json` for a filtered export — the facets
 * are whatever the list was filtered by (`all` when nothing was), so the file
 * says what is in it.
 */
export function traceListBundleFilename(
  query: TraceQuery,
  exportedAt: string,
  timeZone: string,
): string {
  const facets = [
    query.feature ?? "all",
    query.status,
    query.triggerKind,
    query.actor,
    query.correlationId,
    query.relatedId,
  ]
    .filter((value): value is string => Boolean(value))
    .map(slug);
  return `traces-${facets.join("-")}-${stampInZone(exportedAt, timeZone)}.json`;
}
