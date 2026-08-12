"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { fieldBase } from "./Input";

/**
 * Searchable select: a text input that filters a dropdown of options. Built for
 * long model lists, where a native `<select>` means scanning hundreds of ids.
 *
 * Two commit modes:
 * - default: only picking an option commits it; typed text is a filter and
 *   reverts to the committed value on close, so a half-typed id can never be
 *   saved by accident.
 * - `freeText`: every keystroke commits, and the options are suggestions —
 *   for endpoints whose model ids cannot be listed (whisper-class servers).
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  freeText,
  "aria-describedby": describedBy,
}: {
  id?: string;
  /** The committed value ("" = nothing chosen). */
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  /** Commit as the operator types (options become suggestions). */
  freeText?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // A value committed elsewhere (a save, a cleared stale model) resyncs the
  // text — reconciled during render (the sanctioned derived-state pattern),
  // not in an effect.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (!open) setQuery(value);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The committed value acts as "show everything": opening a filled control
    // should offer the full list, not the one entry that matches itself.
    if (!q || q === value.trim().toLowerCase()) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query, value]);

  // The highlight is clamped at read time so a shrinking filter can never
  // leave it pointing past the end.
  const active = highlighted < filtered.length ? highlighted : 0;

  // Close on any pointer press outside the control (blur alone cannot tell an
  // option click from a genuine exit).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    if (!freeText) setQuery(value);
  }

  function commit(next: string) {
    onChange(next);
    setQuery(next);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = filtered.length === 0 ? 0 : (active + delta + filtered.length) % filtered.length;
      setHighlighted(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = filtered[active];
      if (pick !== undefined) commit(pick);
      else if (freeText) close();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          className={cn(fieldBase, "h-9 pr-9 pl-9 text-sm")}
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlighted(0);
            setOpen(true);
            if (freeText) onChange(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
      </div>

      {open ? (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-faint">
              {freeText ? "No suggestions — free text is kept as typed." : "No models match."}
            </li>
          ) : (
            filtered.map((option, index) => (
              <li
                key={option}
                role="option"
                aria-selected={option === value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                  index === active ? "bg-surface-2 text-foreground" : "text-muted",
                )}
                onMouseEnter={() => setHighlighted(index)}
                // pointerdown, not click: it fires before the input's blur.
                onPointerDown={(e) => {
                  e.preventDefault();
                  commit(option);
                }}
              >
                <Check
                  className={cn("h-3.5 w-3.5 shrink-0", option === value ? "opacity-100" : "opacity-0")}
                  aria-hidden
                />
                <span className="truncate">{option}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
