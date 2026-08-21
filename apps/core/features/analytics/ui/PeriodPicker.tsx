"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Button,
  Calendar,
  initialViewRange,
  SegmentedControl,
  type CalendarMode,
  type SegmentedOption,
} from "@/components/ui";
import type { ApiErrorBody, ApiOkBody } from "@/lib/api-error";

import { isAtOrAfterAnchor, reanchor, stepAnchor } from "../period";
import {
  GRANULARITY_LABELS,
  type MetricSource,
  type PeriodUnit,
} from "../types";

/**
 * The dashboard's period control: pick a unit, then navigate between periods of that
 * unit.
 *
 * This replaced a plain "last 30 days / last 26 weeks" selector, which had two
 * problems the navigation fixes: the label never matched the window (choosing "Day"
 * showed a month), and there was no way to look at any period but the most recent
 * one. Here "Day" means one day, `◀`/`▶` step to its neighbours, and the calendar
 * jumps anywhere — with the periods that actually hold data marked, so the reader is
 * not clicking blindly through empty history.
 */

export function PeriodPicker({
  unit,
  anchor,
  units,
  source,
  chatId,
  todayAnchors,
  label,
  onChange,
}: {
  unit: PeriodUnit;
  anchor: string;
  /** Which units this card offers — charts exclude `all`, which has no axis. */
  units: PeriodUnit[];
  /** The card's data source, so the calendar marks what this card can actually show. */
  source: MetricSource;
  chatId: string | null;
  /** The current period per unit, resolved server-side in the operator timezone. */
  todayAnchors: Record<PeriodUnit, string>;
  /** Names the control for screen readers, e.g. the card title. */
  label: string;
  onChange: (next: { unit: PeriodUnit; anchor: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const atLatest = anchor === todayAnchors[unit];

  const options: SegmentedOption<PeriodUnit>[] = units.map((u) => ({
    value: u,
    label: GRANULARITY_LABELS[u],
  }));

  function changeUnit(next: PeriodUnit) {
    onChange({ unit: next, anchor: reanchor(unit, anchor, next, todayAnchors.day) });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        ariaLabel={`Period for ${label}`}
        options={options}
        value={unit}
        onChange={changeUnit}
      />

      {unit === "all" ? null : (
        <div className="relative flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={`Previous ${unit} for ${label}`}
            onClick={() => onChange({ unit, anchor: stepAnchor(unit, anchor, -1) })}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-8 min-w-28 justify-center tabular-nums"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            {anchor}
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={`Next ${unit} for ${label}`}
            // Stepping past the current period would show a window that cannot have
            // data yet, which reads as "the metric broke" rather than "the future".
            disabled={isAtOrAfterAnchor(unit, anchor, todayAnchors[unit])}
            onClick={() => onChange({ unit, anchor: stepAnchor(unit, anchor, 1) })}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={atLatest}
            onClick={() => onChange({ unit, anchor: todayAnchors[unit] })}
          >
            Today
          </Button>

          {open ? (
            <CalendarPopover
              unit={unit}
              anchor={anchor}
              source={source}
              chatId={chatId}
              today={todayAnchors.day}
              onClose={() => setOpen(false)}
              onSelect={(next) => {
                onChange({ unit, anchor: next });
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function CalendarPopover({
  unit,
  anchor,
  source,
  chatId,
  today,
  onSelect,
  onClose,
}: {
  unit: Exclude<PeriodUnit, "all">;
  anchor: string;
  source: MetricSource;
  chatId: string | null;
  today: string;
  onSelect: (anchor: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mode = unit as CalendarMode;
  const [range, setRange] = useState(() => initialViewRange(mode, anchor, today));
  const available = useAvailability(source, unit, chatId, range);

  // Dismiss on an outside click or Escape — a popover that traps the reader on a
  // dashboard of a dozen cards is worse than no popover.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose a period"
      className="absolute right-0 top-9 z-30 rounded-lg border border-border bg-surface p-3 shadow-lg"
    >
      <Calendar
        mode={mode}
        value={anchor}
        available={available}
        today={today}
        onSelect={onSelect}
        onViewChange={setRange}
      />
      <p className="mt-2 border-t border-border pt-2 text-[10px] text-faint">
        <span className="mr-1 inline-block h-1 w-1 rounded-full bg-primary align-middle" aria-hidden />
        has data
      </p>
    </div>
  );
}

/**
 * The set of periods holding data in the browsed range, for this card's own source.
 *
 * Per-source rather than one global answer: the Tokens calendar should mark periods
 * with LLM activity, and the Mood calendar only periods that have actually been
 * scored. A shared answer would promise data some cards cannot show.
 */
function useAvailability(
  source: MetricSource,
  unit: PeriodUnit,
  chatId: string | null,
  range: { from: string; to: string },
): ReadonlySet<string> {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set<string>());

  const query = new URLSearchParams({
    source,
    unit,
    from: range.from,
    to: range.to,
    ...(chatId ? { chatId } : {}),
  }).toString();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analytics/availability?${query}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as ApiOkBody<string[]> | ApiErrorBody;
        if (res.ok) setKeys(new Set((body as ApiOkBody<string[]>).data));
      })
      .catch(() => {
        // Marks are an affordance, not the data. A failed lookup leaves the calendar
        // unmarked rather than blocking navigation with an error.
      });
    return () => controller.abort();
  }, [query]);

  return keys;
}
