"use client";

import { useId, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

/**
 * A compact one-of-N control — a row of pills where exactly one is active.
 *
 * Distinct from {@link Tabs}: that owns panels and switches between them, which is
 * a page-level structure. This owns nothing but the choice, so it fits in a card
 * header next to the title and leaves the card's own content to the card. Arrow
 * keys move between options, matching the tablist behaviour users expect.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers, e.g. "Period". */
  ariaLabel: string;
  className?: string;
}) {
  const baseId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(index + dir + options.length) % options.length];
    onChange(next.value);
    document.getElementById(`${baseId}-${next.value}`)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5", className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${baseId}-${option.value}`}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              selected
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
