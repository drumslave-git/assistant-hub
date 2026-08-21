import { cn } from "@/lib/cn";

export type ProgressTone = "primary" | "success" | "warning" | "danger";

const TONES: Record<ProgressTone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** Horizontal progress/meter bar. `value`/`max` are clamped to a 0–100% fill. */
export function Progress({
  value,
  max = 100,
  tone = "primary",
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", TONES[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
