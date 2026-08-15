"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";

import { Label, Select } from "@/components/ui";
import { featureLabel, groupedFeatureOptions } from "@/lib/features";
import {
  debugFilterHref,
  traceStatusSchema,
  type TraceFilterParams,
  type TraceStatus,
  type TraceTrigger,
} from "@/lib/trace";

const STATUSES = traceStatusSchema.options;

/**
 * Debug list filters (Client Component). Pushes the selected facets into the
 * URL so the Server Component page re-reads with the filter and the view is
 * shareable/refresh-safe. Pagination resets on any filter change. When `features`
 * is omitted the feature dropdown is hidden.
 *
 * Beyond the two dropdowns, facets that arrive by clicking a trace (correlation,
 * trigger kind, actor) render as removable chips — there is nothing to type for
 * them, only an active filter to see and clear.
 */
export function DebugFilters({
  basePath,
  features,
  feature,
  status,
  correlationId,
  triggerKind,
  actor,
}: {
  basePath: string;
  features?: string[];
  feature?: string;
  status?: TraceStatus;
  correlationId?: string;
  triggerKind?: TraceTrigger["kind"];
  actor?: string;
}) {
  const router = useRouter();

  const active: TraceFilterParams = { feature, status, correlationId, triggerKind, actor };

  function navigate(next: TraceFilterParams) {
    router.push(debugFilterHref(next, basePath));
  }

  /** The chip row for click-applied facets: label, value, and a clear control. */
  const chips: Array<{ key: keyof TraceFilterParams; label: string; value: string }> = [
    ...(correlationId ? [{ key: "correlationId" as const, label: "Correlation", value: correlationId }] : []),
    ...(triggerKind ? [{ key: "triggerKind" as const, label: "Trigger", value: triggerKind }] : []),
    ...(actor ? [{ key: "actor" as const, label: "Actor", value: actor }] : []),
  ];

  return (
    <div className="flex flex-wrap items-end gap-3">
      {features ? (
        <div className="space-y-1">
          <Label htmlFor="debug-feature">Feature</Label>
          <Select
            id="debug-feature"
            value={feature ?? ""}
            onChange={(e) => navigate({ ...active, feature: e.target.value || undefined })}
            className="min-w-56"
          >
            <option value="">All features</option>
            {groupedFeatureOptions(features, feature).map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.ids.map((f) => (
                  <option key={f} value={f}>
                    {featureLabel(f)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="debug-status">Status</Label>
        <Select
          id="debug-status"
          value={status ?? ""}
          onChange={(e) =>
            navigate({ ...active, status: (e.target.value || undefined) as TraceStatus | undefined })
          }
          className="min-w-40"
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        >
          <span className="text-faint">{chip.label}:</span>
          <span className="max-w-64 truncate font-mono text-xs text-foreground" title={chip.value}>
            {chip.value}
          </span>
          <button
            type="button"
            aria-label={`Clear ${chip.label.toLowerCase()} filter`}
            className="text-faint hover:text-foreground"
            onClick={() => navigate({ ...active, [chip.key]: undefined })}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}
