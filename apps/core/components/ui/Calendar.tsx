"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";

/**
 * A grid date picker that selects a **period**, not an instant.
 *
 * The dashboard's periods are days, weeks, months and years, so this picks whichever
 * of those the caller asks for and returns that period's key — a Monday's date for a
 * week, `YYYY-MM` for a month. One component rather than four because the only real
 * differences are the cell size and what a cell is called; the browsing, the
 * keyboard behaviour, and the "has data" marking are identical.
 *
 * Presentational and generic: it is handed the set of periods that hold data and
 * knows nothing about where that came from.
 */

export type CalendarMode = "day" | "week" | "month" | "year";

/** How many years a year-mode grid shows at once. */
const YEAR_SPAN = 12;

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Monday-first weekday index (0=Mon..6=Sun) of a UTC date. */
function isoWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

interface DayCell {
  /** `YYYY-MM-DD` */
  date: string;
  dayOfMonth: number;
  /** Belongs to a neighbouring month — shown for grid alignment, dimmed. */
  outside: boolean;
}

/** The 6×7 day grid covering a `YYYY-MM` month, Monday-first. */
function monthGrid(viewMonth: string): DayCell[] {
  const [year, month] = viewMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - isoWeekday(first));

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return {
      date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
      dayOfMonth: d.getUTCDate(),
      outside: d.getUTCMonth() + 1 !== month || d.getUTCFullYear() !== year,
    };
  });
}

/** The Monday-date key of a `YYYY-MM-DD`. */
function weekKeyOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - isoWeekday(dt));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function shiftMonth(viewMonth: string, delta: number): string {
  const [y, m] = viewMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

export function Calendar({
  mode,
  /** The currently selected period key. */
  value,
  /** Period keys that hold data — rendered with a mark. */
  available,
  onSelect,
  /** The `YYYY-MM-DD` of "today", for the today outline. Supplied, never `new Date()`:
   *  the dashboard's today is the operator timezone's, not the browser's. */
  today,
  /** Called when the browsed range changes, so the caller can fetch its marks. */
  onViewChange,
}: {
  mode: CalendarMode;
  value: string;
  available: ReadonlySet<string>;
  onSelect: (periodKey: string) => void;
  today: string;
  onViewChange?: (range: { from: string; to: string }) => void;
}) {
  // The browsed position, seeded from the selection so opening the picker shows
  // where you already are rather than the current month.
  const [view, setView] = useState(() => seedView(mode, value, today));

  const cells = useMemo(() => monthGrid(view.month), [view.month]);

  function browse(delta: number) {
    const next =
      mode === "day" || mode === "week"
        ? { ...view, month: shiftMonth(view.month, delta) }
        : mode === "month"
          ? { ...view, year: view.year + delta }
          : { ...view, year: view.year + delta * YEAR_SPAN };
    setView(next);
    onViewChange?.(viewRange(mode, next));
  }

  return (
    <div className="w-64 space-y-2">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Previous"
          onClick={() => browse(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span className="text-xs font-medium tabular-nums">{viewLabel(mode, view)}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Next"
          onClick={() => browse(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {mode === "day" || mode === "week" ? (
        <div className="grid grid-cols-7 gap-0.5">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1 text-center text-[10px] font-medium text-faint">
              {w}
            </div>
          ))}
          {cells.map((cell) => {
            const key = mode === "week" ? weekKeyOf(cell.date) : cell.date;
            return (
              <CalendarCell
                key={cell.date}
                label={String(cell.dayOfMonth)}
                selected={key === value}
                marked={available.has(key)}
                isToday={cell.date === today}
                dimmed={cell.outside}
                onClick={() => onSelect(key)}
              />
            );
          })}
        </div>
      ) : mode === "month" ? (
        <div className="grid grid-cols-3 gap-1">
          {MONTH_NAMES.map((name, i) => {
            const key = `${view.year}-${pad2(i + 1)}`;
            return (
              <CalendarCell
                key={key}
                label={name}
                selected={key === value}
                marked={available.has(key)}
                isToday={key === today.slice(0, 7)}
                onClick={() => onSelect(key)}
              />
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: YEAR_SPAN }, (_, i) => {
            const year = String(view.year - YEAR_SPAN + 1 + i);
            return (
              <CalendarCell
                key={year}
                label={year}
                selected={year === value}
                marked={available.has(year)}
                isToday={year === today.slice(0, 4)}
                onClick={() => onSelect(year)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function CalendarCell({
  label,
  selected,
  marked,
  isToday,
  dimmed,
  onClick,
}: {
  label: string;
  selected: boolean;
  marked: boolean;
  isToday: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "date" : undefined}
      className={cn(
        "relative flex h-7 items-center justify-center rounded text-xs tabular-nums transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        selected
          ? "bg-primary text-primary-foreground font-medium"
          : "hover:bg-surface-2 text-foreground",
        dimmed && !selected && "text-faint",
        isToday && !selected && "ring-1 ring-border-strong",
      )}
    >
      {label}
      {/* The data mark. A dot rather than a colour change so it survives the
          selected/today/outside states stacking on the same cell. */}
      {marked ? (
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0.5 h-1 w-1 rounded-full",
            selected ? "bg-primary-foreground" : "bg-primary",
          )}
        />
      ) : null}
    </button>
  );
}

interface ViewState {
  /** `YYYY-MM` browsed in day/week mode. */
  month: string;
  /** Browsed year in month mode; the *last* year shown in year mode. */
  year: number;
}

function seedView(mode: CalendarMode, value: string, today: string): ViewState {
  const month = mode === "day" || mode === "week" ? value.slice(0, 7) : today.slice(0, 7);
  const year =
    mode === "month" ? Number(value.slice(0, 4)) : mode === "year" ? Number(value) : Number(today.slice(0, 4));
  return { month, year };
}

function viewLabel(mode: CalendarMode, view: ViewState): string {
  if (mode === "day" || mode === "week") {
    const [y, m] = view.month.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  if (mode === "month") return String(view.year);
  return `${view.year - YEAR_SPAN + 1}–${view.year}`;
}

/** The inclusive period-key range currently visible — what the caller fetches marks for. */
export function viewRange(mode: CalendarMode, view: ViewState): { from: string; to: string } {
  if (mode === "day" || mode === "week") {
    const cells = monthGrid(view.month);
    const first = cells[0].date;
    const last = cells[cells.length - 1].date;
    return mode === "week"
      ? { from: weekKeyOf(first), to: weekKeyOf(last) }
      : { from: first, to: last };
  }
  if (mode === "month") return { from: `${view.year}-01`, to: `${view.year}-12` };
  return { from: String(view.year - YEAR_SPAN + 1), to: String(view.year) };
}

/** The initial visible range for a selection — the caller's first marks fetch. */
export function initialViewRange(
  mode: CalendarMode,
  value: string,
  today: string,
): { from: string; to: string } {
  return viewRange(mode, seedView(mode, value, today));
}
