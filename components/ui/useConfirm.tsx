"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * `window.confirm()`, replaced.
 *
 * The native one is unstyled, ignores the theme, cannot show more than a line of
 * plain text, and — the reason it had to go — browsers let a user suppress it for
 * the rest of the session. For a delete confirmation that means the guard can
 * silently stop appearing, and the next click deletes without asking.
 *
 * Shaped as a promise so it drops into the call sites that used `confirm()`
 * without turning each of them inside out:
 *
 * ```tsx
 * const { confirm, dialog } = useConfirm();
 * // …
 * if (!(await confirm({ title: `Delete "${name}"?` }))) return;
 * // …
 * return <>{dialog}{rest}</>;
 * ```
 */

export interface ConfirmRequest {
  title: string;
  /** The consequence, in a sentence. Say what cannot be undone. */
  body?: ReactNode;
  /** The affirmative button's label — name the action, never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything destructive; it styles the affirmative button. */
  tone?: "danger" | "primary";
}

interface ConfirmState extends ConfirmRequest {
  open: boolean;
}

const CLOSED: ConfirmState = { open: false, title: "" };

export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [state, setState] = useState<ConfirmState>(CLOSED);
  // The pending promise's resolver. A ref rather than state: settling it must
  // not depend on a re-render having happened.
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setState((prev) => ({ ...prev, open: false }));
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const confirm = useCallback((request: ConfirmRequest) => {
    // A second request while one is pending resolves the first as declined —
    // nothing destructive should proceed because its dialog was replaced.
    resolver.current?.(false);
    setState({ ...request, open: true });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const dialog = (
    <Modal
      open={state.open}
      onClose={() => settle(false)}
      title={state.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {state.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={state.tone === "danger" ? "danger" : "primary"}
            onClick={() => settle(true)}
          >
            {state.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        {state.body ?? "This cannot be undone."}
      </p>
    </Modal>
  );

  return { confirm, dialog };
}
