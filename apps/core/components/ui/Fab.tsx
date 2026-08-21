"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button } from "./Button";

/**
 * The floating action button: a page's one main action, pinned to the bottom
 * right of the viewport so it is reachable without scrolling back to the form
 * it belongs to.
 *
 * It **replaces** that inline button rather than shadowing it (user decision,
 * 2026-08-14) — two live copies of one action means two places showing its
 * state, and a reader has to work out whether they do the same thing.
 *
 * Which is why the status travels with it. An inline Save row could put "Saved"
 * or an error next to itself and be read; a floating button that swallowed the
 * only copy of that feedback would make a failed save look like nothing
 * happened. Anything longer than a few words belongs in the page, near what it
 * is about — this slot is for the verdict, not the explanation.
 *
 * Positioning is plain `fixed`, no portal: the dashboard's content column has
 * no transformed ancestor, so the viewport is the containing block. It sits at
 * `z-30`, below the mobile navigation drawer (`z-40`), so an open drawer covers
 * it. {@link import("@/components/layout/AppShell").AppShell} carries the bottom
 * padding that keeps it from covering the last row of a page.
 */

export interface FabProps {
  /** The action, in the imperative — "Save settings", "Create task". */
  label: string;
  /** Shown in place of the label while `busy`. Defaults to "Working…". */
  busyLabel?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  /**
   * The outcome of the last attempt, or a standing reason the action is
   * unavailable — the feedback the inline row used to carry. Keep it short.
   */
  status?: { tone: "success" | "danger" | "muted"; text: ReactNode } | null;
}

const STATUS_TONE: Record<NonNullable<FabProps["status"]>["tone"], string> = {
  success: "border-success/30 bg-success/10 text-success",
  danger: "border-danger/30 bg-danger/10 text-danger",
  muted: "border-border bg-surface text-muted",
};

export function Fab({
  label,
  busyLabel = "Working…",
  icon,
  onClick,
  disabled = false,
  busy = false,
  status = null,
}: FabProps) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-30 flex items-center justify-end gap-2 md:right-8 md:bottom-8">
      {status ? (
        <span
          className={cn(
            "pointer-events-auto max-w-[min(60vw,28rem)] rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg",
            STATUS_TONE[status.tone],
          )}
          // Announced rather than merely drawn: with the button floating away
          // from the form, this is the only report that the action landed.
          role="status"
        >
          {status.text}
        </span>
      ) : null}
      <Button
        size="lg"
        onClick={onClick}
        disabled={disabled || busy}
        leftIcon={icon}
        className="pointer-events-auto rounded-full shadow-lg shadow-black/20"
      >
        {busy ? busyLabel : label}
      </Button>
    </div>
  );
}
