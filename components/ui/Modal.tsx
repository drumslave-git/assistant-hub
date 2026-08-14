"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button } from "./Button";

/**
 * The dashboard's modal dialog: forms and destructive confirmations open here
 * rather than expanding a card in place.
 *
 * Built on the **native `<dialog>`** element driven by `showModal()`, not a
 * hand-rolled overlay. That is not a style preference — `showModal()` supplies
 * the four things a hand-rolled one gets wrong: focus is contained without a
 * trap of our own, the rest of the page is made inert (so a background button
 * cannot be tabbed to or clicked), Escape is handled by the platform, and the
 * dialog renders in the **top layer**, above every stacking context — including
 * the `fixed` Fab, which would otherwise sit on top of it.
 *
 * React state stays the source of truth: the platform's own close paths
 * (Escape, the backdrop) are intercepted and routed back through `onClose`, so
 * `open` never disagrees with what is on screen.
 */

export type ModalSize = "sm" | "md" | "lg";

const SIZES: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-4xl",
};

export interface ModalProps {
  open: boolean;
  /** Called for every dismissal — the close button, Escape, or the backdrop. */
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Action row pinned below the scrolling body (the form's submit lives here). */
  footer?: ReactNode;
  size?: ModalSize;
  /**
   * Block dismissal while a write is in flight. Escape and the backdrop stop
   * closing; the close button disappears. A half-submitted create that vanishes
   * because someone hit Escape leaves no way to know whether it landed.
   */
  busy?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  busy = false,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const dismiss = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // Drive the platform from the prop, never the other way round.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // `showModal()` makes the background inert but does NOT stop it scrolling
  // behind the dialog, which on a long list reads as the page moving on its own.
  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // The platform's own dismissals are cancelled and re-issued through
      // `onClose`, so the parent's state decides whether the dialog is open.
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClose={(event) => {
        event.preventDefault();
        if (open) onClose();
      }}
      // A click that lands on the <dialog> itself is a click on the backdrop:
      // the panel below is a child, so anything inside it never reaches here.
      onClick={(event) => {
        if (event.target === ref.current) dismiss();
      }}
      className={cn(
        // `m-auto` is load-bearing: a native <dialog> is centred by the UA's own
        // `margin: auto`, and Tailwind's preflight zeroes every margin, which
        // parks the dialog in the top-left corner.
        "m-auto w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-0 text-foreground shadow-2xl",
        "backdrop:bg-black/60",
        SIZES[size],
      )}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id={titleId} className="text-sm font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          {busy ? null : (
            <Button variant="ghost" size="icon" onClick={dismiss} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
