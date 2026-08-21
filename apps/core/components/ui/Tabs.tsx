"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Accessible tabbed sections. Self-contained: it owns the tablist and the panels
 * (all panels stay mounted, inactive ones `hidden`, so consumer state inside a
 * panel survives switching). Uncontrolled by default (`defaultTabId`); pass
 * `value` + `onValueChange` to control it. Arrow keys move between tabs.
 */

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

export function Tabs({
  tabs,
  defaultTabId,
  value,
  onValueChange,
  className,
}: {
  tabs: TabItem[];
  /** Initially-active tab when uncontrolled. Defaults to the first tab. */
  defaultTabId?: string;
  /** Active tab id for controlled use. */
  value?: string;
  onValueChange?: (id: string) => void;
  className?: string;
}) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultTabId ?? tabs[0]?.id);
  const active = value ?? internal;

  function select(id: string) {
    if (value === undefined) setInternal(id);
    onValueChange?.(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + dir + tabs.length) % tabs.length];
    select(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  }

  return (
    <div className={className}>
      <div role="tablist" className="flex gap-1 border-b border-border">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${baseId}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="pt-5"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
