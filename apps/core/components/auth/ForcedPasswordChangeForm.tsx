"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * The temporary-password replacement form (`/password`): an account created
 * by an admin signs in with the handed-over password and is held here until
 * it is replaced. Posts to the same change-password endpoint the Settings
 * Security tab uses; the response re-cookies this session, so a hard
 * navigation lands in the dashboard as normal.
 */
export function ForcedPasswordChangeForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
        aria-label="Temporary password"
        placeholder="Temporary password"
        autoFocus
      />
      <Input
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
        aria-label="New password"
        placeholder="New password"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button
        type="submit"
        disabled={busy || currentPassword.length === 0 || newPassword.length === 0}
        className="w-full"
      >
        {busy ? "Working…" : "Set new password"}
      </Button>
    </form>
  );
}
