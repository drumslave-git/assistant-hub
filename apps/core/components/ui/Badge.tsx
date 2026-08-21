import { cn } from "@/lib/cn";
import type { HTMLAttributes } from "react";

export type BadgeTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  primary: "bg-primary-soft text-primary border-primary/30",
  success: "bg-success/10 text-success border-success/30",
  warning: "bg-warning/10 text-warning border-warning/30",
  danger: "bg-danger/10 text-danger border-danger/30",
  info: "bg-info/10 text-info border-info/30",
};

/** Compact status/label pill. Set `dot` for a leading status dot. */
export function Badge({
  className,
  tone = "neutral",
  dot = false,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          className="h-1.5 w-1.5 rounded-full bg-current"
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}
