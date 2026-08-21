import { cn } from "@/lib/cn";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * Surface container used across the dashboard. `interactive` adds hover affordance
 * for clickable cards; `muted` uses the recessed surface for nested panels.
 */
export function Card({
  className,
  interactive = false,
  muted = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border",
        muted ? "bg-surface-2" : "bg-surface",
        interactive &&
          "transition-colors hover:border-border-strong hover:bg-surface-hover",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 px-5 pt-5",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  as: Tag = "h3",
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag
      className={cn("text-sm font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}

export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border px-5 py-4",
        className,
      )}
      {...props}
    />
  );
}

/** Slot for a title-row action (button, menu, link) inside CardHeader. */
export function CardAction({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2">{children}</div>;
}
