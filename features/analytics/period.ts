/**
 * Pure bucket math for the analytics dashboard — dependency-free via `Intl`, so it
 * is client-safe and directly unit-testable.
 *
 * The dashboard's filter is **one selected period**, not a trailing window: a card
 * shows `day 2026-07-18` (that day, 00:00–24:00 on the operator's wall clock) and
 * you step to the next or previous one. This module owns the whole contract:
 *
 *  - {@link periodRange} turns a `(unit, anchor)` pair into the half-open UTC
 *    instant range `[startUtc, endUtc)` every query filters on. Half-open is the
 *    point — the previous shape had a lower bound only, so "day" and "week" both
 *    swallowed all recent history and reported identical totals.
 *  - {@link subBucketKeys} turns the same pair into the dense chart axis *inside*
 *    the period (a day is 24 hours, a year is 12 months), which is what makes every
 *    period draw a real line instead of one dot.
 *  - {@link stepAnchor} / {@link currentAnchor} drive the period navigation.
 *
 * The **exact same** bucket-key format is produced here in JS (to build the dense,
 * gap-free axis) and by Postgres `to_char(date_trunc(...))` in the repository (to
 * group the values) — the two must agree, which the unit tests pin. Weeks are ISO
 * weeks (Monday start), matching Postgres `date_trunc('week', …)`; a week's key is
 * its Monday's date.
 */

import { addCalendarDays, zonedWallClockToUtc } from "@/features/tasks/schedule";

import type { Granularity, PeriodUnit } from "./types";

/** Far-future sentinel for the open end of the `all` range. */
const FOREVER = new Date("9999-12-31T00:00:00.000Z");

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Wall-clock Y/M/D/H of an instant in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return { year: map.year, month: map.month, day: map.day, hour: map.hour };
}

/** The `date_trunc` unit for a granularity (null for `all`, which has no unit). */
export function truncUnit(
  granularity: Granularity,
): "hour" | "day" | "week" | "month" | "year" | null {
  return granularity === "all" ? null : granularity;
}

/**
 * The Postgres `to_char` format string matching {@link bucketKey}. Applied to
 * `date_trunc(unit, ts at time zone tz)` it yields the identical string this module
 * builds in JS. Week uses the same date form as day — the difference is the
 * `date_trunc` unit (week truncates to its Monday).
 */
export function bucketFormat(granularity: Granularity): string {
  switch (granularity) {
    case "hour":
      return "YYYY-MM-DD HH24";
    case "day":
    case "week":
      return "YYYY-MM-DD";
    case "month":
      return "YYYY-MM";
    case "year":
      return "YYYY";
    case "all":
      return "all";
  }
}

/** Weekday 0=Sun..6=Sat for a Y/M/D date. */
function weekdayOfYmd(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The Monday (ISO week start) of the week containing a Y/M/D date. */
function mondayOf(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const back = (weekdayOfYmd(year, month, day) + 6) % 7;
  return addCalendarDays(year, month, day, -back);
}

/** Days in a calendar month (day 0 of the next month is the last of this one). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The bucket key for wall-clock parts at a granularity. */
export function bucketKey(parts: ZonedParts, granularity: Granularity): string {
  switch (granularity) {
    case "hour":
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}`;
    case "day":
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    case "week": {
      const m = mondayOf(parts.year, parts.month, parts.day);
      return `${m.year}-${pad2(m.month)}-${pad2(m.day)}`;
    }
    case "month":
      return `${parts.year}-${pad2(parts.month)}`;
    case "year":
      return `${parts.year}`;
    case "all":
      return "all";
  }
}

/** The bucket key an instant falls into, in `timeZone`. */
export function bucketKeyOfInstant(
  instant: Date,
  granularity: Granularity,
  timeZone: string,
): string {
  return bucketKey(zonedParts(instant, timeZone), granularity);
}

/** The Monday-date bucket key for a `YYYY-MM-DD` day string. */
export function weekBucketOf(dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const m = mondayOf(y, mo, d);
  return `${m.year}-${pad2(m.month)}-${pad2(m.day)}`;
}

/** Add `n` days to a `YYYY-MM-DD` string, returning a `YYYY-MM-DD` string. */
export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const r = addCalendarDays(y, mo, d, n);
  return `${r.year}-${pad2(r.month)}-${pad2(r.day)}`;
}

/**
 * The granularity a period is charted at — one step finer than the period itself.
 *
 * This is what gives every period a real line: a day is 24 hourly points, a year is
 * 12 monthly ones. A month is charted daily rather than weekly because partial weeks
 * at both ends of a month are a worse lie than 31 honest points.
 *
 * `all` has no bounded axis to enumerate, so it is not offered on chart cards; the
 * month answer here is the sensible one for any caller that asks anyway.
 */
export function subUnitOf(unit: PeriodUnit): Granularity {
  switch (unit) {
    case "day":
      return "hour";
    case "week":
    case "month":
      return "day";
    case "year":
      return "month";
    case "all":
      return "month";
  }
}

export interface PeriodRange {
  /** Inclusive lower bound. */
  startUtc: Date;
  /** **Exclusive** upper bound — the instant the next period begins. */
  endUtc: Date;
}

/**
 * The half-open UTC instant range a `(unit, anchor)` period covers, on the
 * operator's wall clock.
 *
 * Exclusive upper bound rather than an inclusive "end of period" instant: there is
 * no last representable moment of a day, so any inclusive bound either double-counts
 * the boundary row or silently drops it. `sent_at >= start and sent_at < end` has
 * neither failure mode and tiles across periods exactly.
 */
export function periodRange(unit: PeriodUnit, anchor: string, timeZone: string): PeriodRange {
  if (unit === "all") return { startUtc: new Date(0), endUtc: FOREVER };

  const at = (y: number, m: number, d: number) => zonedWallClockToUtc(y, m, d, 0, 0, timeZone);

  switch (unit) {
    case "day": {
      const [y, m, d] = anchor.split("-").map(Number);
      const next = addCalendarDays(y, m, d, 1);
      return { startUtc: at(y, m, d), endUtc: at(next.year, next.month, next.day) };
    }
    case "week": {
      const [y, m, d] = anchor.split("-").map(Number);
      const next = addCalendarDays(y, m, d, 7);
      return { startUtc: at(y, m, d), endUtc: at(next.year, next.month, next.day) };
    }
    case "month": {
      const [y, m] = anchor.split("-").map(Number);
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      return { startUtc: at(y, m, 1), endUtc: at(nextY, nextM, 1) };
    }
    case "year": {
      const y = Number(anchor);
      return { startUtc: at(y, 1, 1), endUtc: at(y + 1, 1, 1) };
    }
  }
}

/**
 * The dense chart axis inside a period, oldest → newest, at {@link subUnitOf}'s
 * granularity. Built in JS so a bucket with no rows is a visible gap rather than a
 * missing point — the values are joined onto this axis, never the other way round.
 *
 * Empty for `all`, which has no bounded axis (chart cards do not offer it).
 */
export function subBucketKeys(unit: PeriodUnit, anchor: string): string[] {
  switch (unit) {
    case "day":
      return Array.from({ length: 24 }, (_, h) => `${anchor} ${pad2(h)}`);
    case "week":
      return Array.from({ length: 7 }, (_, i) => addDaysToDateStr(anchor, i));
    case "month": {
      const [y, m] = anchor.split("-").map(Number);
      return Array.from(
        { length: daysInMonth(y, m) },
        (_, i) => `${anchor}-${pad2(i + 1)}`,
      );
    }
    case "year":
      return Array.from({ length: 12 }, (_, i) => `${anchor}-${pad2(i + 1)}`);
    case "all":
      return [];
  }
}

/** Step an anchor `delta` periods (negative = earlier), calendar-aware. */
export function stepAnchor(unit: PeriodUnit, anchor: string, delta: number): string {
  switch (unit) {
    case "day":
      return addDaysToDateStr(anchor, delta);
    case "week":
      return addDaysToDateStr(anchor, delta * 7);
    case "month": {
      const [y, m] = anchor.split("-").map(Number);
      const total = y * 12 + (m - 1) + delta;
      return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
    }
    case "year":
      return String(Number(anchor) + delta);
    case "all":
      return "all";
  }
}

/** The anchor of the period `now` falls in, on the operator's wall clock. */
export function currentAnchor(unit: PeriodUnit, now: Date, timeZone: string): string {
  return unit === "all" ? "all" : bucketKey(zonedParts(now, timeZone), unit);
}

/** The `YYYY-MM-DD` a period anchor starts on — its representative date. */
export function anchorStartDate(unit: PeriodUnit, anchor: string, todayDate: string): string {
  switch (unit) {
    case "day":
    case "week":
      return anchor;
    case "month":
      return `${anchor}-01`;
    case "year":
      return `${anchor}-01-01`;
    case "all":
      return todayDate;
  }
}

/** The anchor for a `YYYY-MM-DD` date at a given unit. */
export function anchorOfDate(unit: PeriodUnit, date: string): string {
  switch (unit) {
    case "day":
      return date;
    case "week":
      return weekBucketOf(date);
    case "month":
      return date.slice(0, 7);
    case "year":
      return date.slice(0, 4);
    case "all":
      return "all";
  }
}

/**
 * Carry the current position across a unit change — switching from `day 2026-07-18`
 * to Month lands on `2026-07`, not on today.
 *
 * Resetting to the current period instead would silently throw away where the reader
 * had navigated to, which is the one thing they were looking at.
 */
export function reanchor(
  fromUnit: PeriodUnit,
  anchor: string,
  toUnit: PeriodUnit,
  todayDate: string,
): string {
  return anchorOfDate(toUnit, anchorStartDate(fromUnit, anchor, todayDate));
}

/**
 * Whether an anchor is at or past the current period — what disables the "next"
 * button.
 *
 * Compares against a *supplied* current anchor rather than reading the clock, so the
 * client can use it: "now" on this dashboard is the operator timezone's now,
 * resolved on the server, and the browser's clock must not get a vote.
 *
 * A plain string compare is correct: every anchor form is fixed-width and
 * zero-padded, so lexical order is chronological order.
 */
export function isAtOrAfterAnchor(
  unit: PeriodUnit,
  anchor: string,
  currentAnchorForUnit: string,
): boolean {
  if (unit === "all") return true;
  return anchor >= currentAnchorForUnit;
}

/** Align a sparse `key → value` map onto the dense `keys` axis, filling gaps with 0. */
export function densify(keys: string[], byBucket: Map<string, number>): number[] {
  return keys.map((k) => byBucket.get(k) ?? 0);
}
