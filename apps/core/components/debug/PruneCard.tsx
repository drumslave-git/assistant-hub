"use client";

import { Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * Manual prune of old trace months (user decision, 2026-07-20: manual only —
 * there is no automatic retention, so this card is the single way stored traces
 * are ever deleted). The operator picks a stored month; every month file
 * strictly OLDER than it is deleted. Destructive and irreversible — the month
 * files are the only copy of the full request/response bodies — so the button
 * is a two-step confirm that names exactly what it is about to delete.
 */
export function PruneCard({ months }: { months: string[] }) {
  const router = useRouter();
  // Oldest stored months first; "before X" can never delete the newest month
  // (the one still being written), which is exactly right.
  const cutoffs = months.slice(1);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const selected = cutoff ?? cutoffs[0] ?? null;
  const doomed = selected ? months.filter((m) => m < selected) : [];

  async function prune() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/traces/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beforeMonth: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { data: { months: string[]; traces: number } };
      setLastResult(
        `Deleted ${body.data.months.length} month file(s) — ${body.data.traces} trace(s) removed.`,
      );
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="space-y-1">
          <CardTitle>Prune stored traces</CardTitle>
          <CardDescription>
            Permanently delete trace files for months older than a chosen month. Nothing is ever
            deleted automatically — this action is the only way.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {cutoffs.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing to prune — at most one stored month exists, and the newest month is never
            deletable.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Delete everything before</span>
            <Select
              aria-label="Keep traces from this month on"
              className="h-8 w-auto min-w-32 text-xs"
              value={selected ?? ""}
              onChange={(e) => {
                setCutoff(e.target.value);
                setConfirming(false);
              }}
            >
              {cutoffs.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            {confirming ? (
              <>
                <Button variant="danger" size="sm" onClick={prune} disabled={busy}>
                  <TriangleAlert className="h-4 w-4" aria-hidden />
                  {busy ? "Deleting…" : `Yes, delete ${doomed.length} month file(s)`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirming(true)}
                disabled={busy || doomed.length === 0}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete older traces
              </Button>
            )}
          </div>
        )}
        {confirming && doomed.length > 0 ? (
          <p className="text-sm text-danger">
            This permanently deletes {doomed.join(", ")} — every stored trace in{" "}
            {doomed.length === 1 ? "that month" : "those months"}, including full request and
            response bodies. It cannot be undone.
          </p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {lastResult && !confirming ? <p className="text-sm text-muted">{lastResult}</p> : null}
      </CardContent>
    </Card>
  );
}
