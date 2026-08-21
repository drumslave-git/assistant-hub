import { cn } from "@/lib/cn";
import type { InputHTMLAttributes } from "react";

/**
 * Toggle switch built on a native checkbox (peer-styled), so it works in plain
 * forms and as a controlled input alike without requiring client JS.
 */
export function Switch({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center", className)}>
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        className={cn(
          "relative h-5 w-9 rounded-full bg-surface-hover transition-colors",
          "peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          "after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:content-['']",
          "peer-checked:after:translate-x-4",
        )}
      />
    </label>
  );
}
