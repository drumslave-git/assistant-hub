import { cn } from "@/lib/cn";
import { Card } from "./Card";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

type IconComponent = ComponentType<{ className?: string }>;

/**
 * Metric card: large value, label, optional icon and trend delta. `accent`
 * gives the primary-tinted highlight variant used for the lead stat.
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  hint,
  accent = false,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: IconComponent;
  trend?: { value: string; direction: "up" | "down" };
  hint?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "relative overflow-hidden p-5",
        accent && "border-primary/40 bg-primary-soft",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-muted">{label}</span>
        {Icon ? (
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg",
              accent ? "bg-primary/15 text-primary" : "bg-surface-2 text-muted",
            )}
          >
            <Icon className="h-4.5 w-4.5" />
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        {trend ? (
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-0.5 text-xs font-medium",
              trend.direction === "up" ? "text-success" : "text-danger",
            )}
          >
            {trend.direction === "up" ? (
              <ArrowUpRight className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5" />
            )}
            {trend.value}
          </span>
        ) : null}
      </div>
      {hint ? <div className="mt-1 text-xs text-faint">{hint}</div> : null}
    </Card>
  );
}
