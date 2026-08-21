import { cn } from "@/lib/cn";
import { Check } from "lucide-react";
import type { InputHTMLAttributes } from "react";

/** Checkbox built on a native input with a peer-styled box and check glyph. */
export function Checkbox({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label
      className={cn(
        "relative inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center",
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded border border-border-strong bg-surface-2 transition-colors",
          "peer-checked:border-primary peer-checked:bg-primary",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        )}
      />
      <Check
        className="pointer-events-none absolute h-3 w-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
        strokeWidth={3}
        aria-hidden
      />
    </label>
  );
}
