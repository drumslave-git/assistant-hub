import { cn } from "@/lib/cn";
import type { InputHTMLAttributes } from "react";

const fieldBase =
  "w-full rounded-lg border border-border bg-surface-2 text-foreground placeholder:text-faint " +
  "transition-colors focus:border-primary/60 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/30";

export { fieldBase };

export function Input({
  className,
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "h-9 px-3 text-sm", className)}
      {...props}
    />
  );
}
