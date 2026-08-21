import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * Vertically capped scroll container for long page sections — tables, lists,
 * timelines. Caps the section at a fraction of the viewport so one dense panel
 * never stretches the whole page; overflow scrolls inside the panel instead.
 * Every wrapper around a growing collection should use this (directly or via
 * the shared `Table`), so scroll behavior stays identical across features.
 */
export function ScrollArea({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("max-h-[70vh] overflow-y-auto", className)} {...props} />
  );
}
