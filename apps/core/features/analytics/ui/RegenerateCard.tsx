"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SegmentedControl,
  Select,
  type SegmentedOption,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

import { GRANULARITIES, GRANULARITY_LABELS, type AnalyticsJobInfo, type Granularity } from "../types";

/**
 * Drop a period's stored insights and compute them again.
 *
 * This is the deliberate replacement for the job silently re-reading days whose
 * message count had drifted. That reconciliation made the nightly token spend a
 * function of invisible state and could rewrite a score nobody asked it to touch;
 * correcting a score is now something an operator asks for, at a period they name.
 *
 * It is destructive and billable — every day score covering the period is deleted
 * and re-scored with one LLM pass each — so the button confirms before it fires and
 * says exactly what it is about to throw away.
 */
const PERIOD_OPTIONS: SegmentedOption<Granularity>[] = GRANULARITIES.map((g) => ({
  value: g,
  label: GRANULARITY_LABELS[g],
}));

export function RegenerateCard({ job }: { job: AnalyticsJobInfo }) {
  const router = useRouter();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [bucket, setBucket] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buckets = job.regenerateBuckets[granularity] ?? [];
  // "All time" is a single bucket, so there is nothing to pick.
  const selected = granularity === "all" ? "all" : (bucket ?? buckets[0] ?? null);
  const blocked = !job.llmConfigured || selected === null;

  function choose(next: Granularity) {
    setGranularity(next);
    setBucket(null); // a bucket key means nothing at a different granularity
    setConfirming(false);
  }

  async function regenerate() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/analytics/insights/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granularity, bucket: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const target =
    granularity === "all" ? "every scored day in the whole history" : `${GRANULARITY_LABELS[granularity].toLowerCase()} ${selected}`;

  return (
    <Card>
      <CardHeader>
        <div className="space-y-1">
          <CardTitle>Regenerate insights</CardTitle>
          <CardDescription>
            Drop a period&rsquo;s stored mood, word, and topic and compute them again from the messages.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            ariaLabel="Period to regenerate"
            options={PERIOD_OPTIONS}
            value={granularity}
            onChange={choose}
          />
          {granularity === "all" ? null : (
            <Select
              aria-label="Bucket to regenerate"
              className="h-8 w-auto min-w-36 text-xs"
              value={selected ?? ""}
              onChange={(e) => {
                setBucket(e.target.value);
                setConfirming(false);
              }}
              disabled={buckets.length === 0}
            >
              {buckets.length === 0 ? (
                <option value="">Nothing scored yet</option>
              ) : (
                buckets.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))
              )}
            </Select>
          )}
          <Button
            type="button"
            variant={confirming ? "danger" : "outline"}
            size="sm"
            disabled={blocked || busy}
            leftIcon={<RotateCcw className="h-4 w-4" />}
            onClick={() => (confirming ? void regenerate() : setConfirming(true))}
          >
            {busy ? "Starting…" : confirming ? "Confirm — drop & regenerate" : "Drop & regenerate"}
          </Button>
          {confirming && !busy ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          ) : null}
        </div>

        {confirming ? (
          <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              This deletes the stored insights for {target} — the day scores and every roll-up built
              from them — and re-scores each dropped day with one LLM call. Roll-ups at other periods
              that covered those days go too, and are rebuilt.
            </span>
          </p>
        ) : (
          <p className="text-xs text-faint">
            {job.llmConfigured
              ? `Ready to regenerate ${target}.`
              : "No LLM configured — set one in Settings before regenerating."}
          </p>
        )}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
