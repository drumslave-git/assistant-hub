import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Shared offset pagination for server-rendered lists.
 *
 * Presentational on purpose: the caller supplies {@link PaginationProps.hrefFor},
 * so the control works in a Server Component and every page stays a real URL —
 * shareable, refresh-safe, and back/forward-navigable. A list that fits on one
 * page renders nothing at all.
 */
export interface PaginationProps {
  /** Total rows matching the filter, across all pages. */
  total: number;
  /** Rows per page. */
  limit: number;
  /** Offset of the page being shown. */
  offset: number;
  /** URL for the page starting at `offset`. */
  hrefFor: (offset: number) => string;
  /** Row noun for the count line, e.g. "trace". Pluralized with a trailing "s". */
  noun?: string;
  className?: string;
}

const linkClass =
  "inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface-2 px-2.5 text-xs font-medium text-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none";
const disabledClass = "pointer-events-none opacity-40";

export function Pagination({
  total,
  limit,
  offset,
  hrefFor,
  noun = "row",
  className,
}: PaginationProps) {
  if (total <= limit) return null;

  const pages = Math.ceil(total / limit);
  // Clamp: a stale/handcrafted offset must not report "page 9 of 3".
  const page = Math.min(Math.floor(offset / limit) + 1, pages);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="text-sm text-muted">
        {first}–{last} of {total} {noun}
        {total === 1 ? "" : "s"}
      </p>
      <div className="flex items-center gap-2">
        <Link
          href={hrefFor(Math.max(offset - limit, 0))}
          aria-label="Previous page"
          aria-disabled={page === 1 || undefined}
          tabIndex={page === 1 ? -1 : undefined}
          className={cn(linkClass, page === 1 && disabledClass)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </Link>
        <span className="text-xs text-faint">
          Page {page} of {pages}
        </span>
        <Link
          href={hrefFor(offset + limit)}
          aria-label="Next page"
          aria-disabled={page === pages || undefined}
          tabIndex={page === pages ? -1 : undefined}
          className={cn(linkClass, page === pages && disabledClass)}
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
