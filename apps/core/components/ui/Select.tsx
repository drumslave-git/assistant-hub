import { cn } from "@/lib/cn";
import { fieldBase } from "./Input";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

/** Native select styled to match the kit, with a custom chevron affordance. */
export function Select({
  className,
  invalid,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          fieldBase,
          "h-9 appearance-none pr-9 pl-3 text-sm",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-faint"
        aria-hidden
      />
    </div>
  );
}
