import { cn } from "@/lib/cn";
import { fieldBase } from "./Input";
import type { TextareaHTMLAttributes } from "react";

export function Textarea({
  className,
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "min-h-20 px-3 py-2 text-sm leading-relaxed", className)}
      {...props}
    />
  );
}
