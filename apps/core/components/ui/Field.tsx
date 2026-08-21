import { cn } from "@/lib/cn";
import { Label } from "./Label";
import type { ReactNode } from "react";

/**
 * Standard labelled form row: label, control, and either a hint or an error
 * message. Wires `htmlFor`/`id` and aria-describedby so features get consistent,
 * accessible fields without repeating the plumbing.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** Receives `{ id, describedBy }` to spread onto the control. */
  children: (props: { id: string; describedBy?: string }) => ReactNode;
}) {
  const describedBy = error
    ? `${id}-error`
    : hint
      ? `${id}-hint`
      : undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      ) : null}
      {children({ id, describedBy })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
