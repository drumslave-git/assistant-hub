import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { cn } from "@/lib/cn";
import { ScrollArea } from "./ScrollArea";

/**
 * Shared table primitives — the presentational chrome (scroll container, borders,
 * padding, header typography) used by every dense dashboard table so they read as
 * one system. Features compose their own rows/cells (clickable, editable, …) from
 * these; this layer owns look, not behavior.
 */

const ALIGN: Record<"left" | "center" | "right", string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const VALIGN: Record<"top" | "middle" | "bottom", string> = {
  top: "align-top",
  middle: "align-middle",
  bottom: "align-bottom",
};

/** Scrollable (both axes, height-capped), bordered wrapper around a `<table>`. */
export function Table({
  className,
  minWidth,
  children,
  ...props
}: HTMLAttributes<HTMLTableElement> & { minWidth?: number | string }) {
  const min = typeof minWidth === "number" ? `${minWidth}px` : minWidth;
  return (
    <ScrollArea className="overflow-x-auto rounded-lg border border-border">
      <table
        className={cn("w-full border-collapse text-sm", className)}
        style={min ? { minWidth: min } : undefined}
        {...props}
      >
        {children}
      </table>
    </ScrollArea>
  );
}

export function TableHead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...props} />;
}

export function TableBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

/**
 * Table row. `header` rows get a bottom divider; `interactive` body rows get a
 * hover state and `group`/`relative` so a cell can host a stretched link.
 */
export function TableRow({
  className,
  header = false,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & {
  header?: boolean;
  interactive?: boolean;
}) {
  return (
    <tr
      className={cn(
        header
          ? "border-b border-border"
          : "border-b border-border last:border-0",
        interactive &&
          "group relative cursor-pointer transition-colors hover:bg-surface-hover",
        className,
      )}
      {...props}
    />
  );
}

/** Header cell — the uppercase, faint column-label style. */
export function TableHeaderCell({
  className,
  align = "left",
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "center" | "right";
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-xs font-medium tracking-wide text-faint uppercase",
        ALIGN[align],
        className,
      )}
      {...props}
    />
  );
}

/** Body cell. */
export function TableCell({
  className,
  align = "left",
  valign = "top",
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}) {
  return (
    <td
      className={cn("px-3 py-2", ALIGN[align], VALIGN[valign], className)}
      {...props}
    />
  );
}
