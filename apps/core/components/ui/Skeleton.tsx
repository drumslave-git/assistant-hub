import { cn } from "@/lib/cn";
import { Loader2 } from "lucide-react";

/** Shimmering placeholder block for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-2", className)}
      aria-hidden
    />
  );
}

/** Inline spinner for buttons and small loading affordances. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("h-4 w-4 animate-spin text-current", className)}
      aria-label="Loading"
    />
  );
}
