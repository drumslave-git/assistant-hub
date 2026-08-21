import { cn } from "@/lib/cn";
import type { ComponentType, ReactNode } from "react";

/**
 * Standard empty/zero-state for lists, tables, and panels: optional icon,
 * title, description, and an action slot. Keeps "nothing here yet" consistent
 * across features.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
