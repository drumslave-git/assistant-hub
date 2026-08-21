"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * The one password form both auth pages render: `/login` posts to the login
 * endpoint, `/setup` to the first-run setup endpoint. On success the session
 * cookie is already set by the response; a hard navigation reloads the
 * server-rendered tree as an authenticated visitor.
 */
export function AuthPasswordForm({
  endpoint,
  submitLabel,
  autoComplete,
}: {
  endpoint: string;
  submitLabel: string;
  autoComplete: "current-password" | "new-password";
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
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
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={autoComplete}
        aria-label="Operator password"
        placeholder="Password"
        autoFocus
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" disabled={busy || password.length === 0} className="w-full">
        {busy ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
