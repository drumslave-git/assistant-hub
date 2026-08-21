"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Button, Field, Input } from "@/components/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { readError } from "./connection";

type ChangeState =
  | { kind: "idle" }
  | { kind: "changing" }
  | { kind: "changed" }
  | { kind: "error"; message: string };

/**
 * The Settings Security tab: change the operator password. Posts to its own
 * endpoint rather than riding the settings Save button — the change needs the
 * current password and rotates the session secret, which is an auth action, not
 * a settings patch. Rendered inside the settings `<form>`, so this is a plain
 * `div` (no nested form) and Enter in either field submits from here.
 */
export function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [state, setState] = useState<ChangeState>({ kind: "idle" });

  const ready = currentPassword.length > 0 && newPassword.length > 0;

  async function onChangePassword() {
    if (!ready || state.kind === "changing") return;
    setState({ kind: "changing" });
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        setState({ kind: "error", message: await readError(res) });
        return;
      }
      // The response already replaced the session cookie, so this session stays
      // signed in; every other session was just invalidated.
      setCurrentPassword("");
      setNewPassword("");
      setState({ kind: "changed" });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  function onEnter(event: React.KeyboardEvent) {
    if (event.key !== "Enter") return;
    // Keep Enter from submitting the surrounding settings form (Test connection).
    event.preventDefault();
    void onChangePassword();
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Changing the password signs out every other session, including other browsers and
        devices. This one stays signed in.
      </p>

      <Field id="currentPassword" label="Current password">
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setState({ kind: "idle" });
            }}
            onKeyDown={onEnter}
          />
        )}
      </Field>

      <Field
        id="newPassword"
        label="New password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setState({ kind: "idle" });
            }}
            onKeyDown={onEnter}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onChangePassword}
          disabled={!ready || state.kind === "changing"}
          leftIcon={<KeyRound className="h-4 w-4" />}
        >
          {state.kind === "changing" ? "Changing…" : "Change password"}
        </Button>
        {state.kind === "changed" ? (
          <span className="text-sm text-success">Password changed — other sessions signed out</span>
        ) : null}
        {state.kind === "error" ? (
          <span className="text-sm text-danger">{state.message}</span>
        ) : null}
      </div>
    </div>
  );
}
