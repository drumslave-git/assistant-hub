"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input, Label, Select } from "@/components/ui";
import { featureLabel, groupedFeatureOptions } from "@/lib/features";
import {
  debugFilterHref,
  traceStatusSchema,
  traceTriggerSchema,
  type TraceFilterParams,
  type TraceStatus,
  type TraceTrigger,
} from "@/lib/trace";

const STATUSES = traceStatusSchema.options;
const TRIGGER_KINDS = traceTriggerSchema.shape.kind.options;

/**
 * One free-text facet control (actor, correlation): applies on Enter or blur,
 * clears with its × — so typing does not navigate per keystroke, and an active
 * value arriving from a URL or a clicked facet is visible and editable.
 * Callers key this by `value`, so a navigation (clicked facet, back button)
 * remounts the field with the fresh value; local state only bridges keystrokes.
 */
function TextFilter({
  id,
  label,
  placeholder,
  value,
  onApply,
}: {
  id: string;
  label: string;
  placeholder: string;
  value?: string;
  onApply: (next: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");

  const apply = () => {
    const next = draft.trim() || undefined;
    if (next !== value) onApply(next);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          className={value ? "min-w-44 pr-8" : "min-w-44"}
        />
        {value ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()} filter`}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-foreground"
            onClick={() => onApply(undefined)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Debug list filters (Client Component). Every facet the URL accepts is a
 * control here — feature, status, trigger kind, actor, correlation — because a
 * filter that only exists as a query parameter is invisible (user rule,
 * 2026-08-15). Selections push into the URL so the Server Component page
 * re-reads with the filter and the view is shareable/refresh-safe; pagination
 * resets on any change. When `features` is omitted the feature dropdown is
 * hidden (scoped Debug pages).
 */
export function DebugFilters({
  basePath,
  features,
  feature,
  assistants,
  assistantId,
  status,
  correlationId,
  triggerKind,
  actor,
  relatedId,
  flow,
}: {
  basePath: string;
  features?: string[];
  feature?: string;
  /** The assistants to choose from; omitted hides the dropdown (none exist). */
  assistants?: { id: string; name: string }[];
  assistantId?: string;
  status?: TraceStatus;
  correlationId?: string;
  triggerKind?: TraceTrigger["kind"];
  actor?: string;
  relatedId?: string;
  flow?: string;
}) {
  const router = useRouter();

  const active: TraceFilterParams = {
    feature,
    assistantId,
    status,
    correlationId,
    triggerKind,
    actor,
    relatedId,
    flow,
  };

  function navigate(next: TraceFilterParams) {
    router.push(debugFilterHref(next, basePath));
  }

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

      {assistants?.length ? (
        <div className="space-y-1">
          <Label htmlFor="debug-assistant">Assistant</Label>
          <Select
            id="debug-assistant"
            value={assistantId ?? ""}
            onChange={(e) => navigate({ ...active, assistantId: e.target.value || undefined })}
            className="min-w-44"
          >
            <option value="">All assistants</option>
            {assistants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            {/* A filter arriving from a clicked facet may name an assistant
                that has since been deleted — keep it selectable rather than
                silently resetting the view to "all". */}
            {assistantId && !assistants.some((a) => a.id === assistantId) ? (
              <option value={assistantId}>{assistantId} (deleted)</option>
            ) : null}
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

      <div className="space-y-1">
        <Label htmlFor="debug-trigger">Trigger</Label>
        <Select
          id="debug-trigger"
          value={triggerKind ?? ""}
          onChange={(e) =>
            navigate({
              ...active,
              triggerKind: (e.target.value || undefined) as TraceTrigger["kind"] | undefined,
            })
          }
          className="min-w-36"
        >
          <option value="">Any trigger</option>
          {TRIGGER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </Select>
      </div>

      <TextFilter
        key={`actor:${actor ?? ""}`}
        id="debug-actor"
        label="Actor"
        placeholder="chat / user / job id"
        value={actor}
        onApply={(next) => navigate({ ...active, actor: next })}
      />

      <TextFilter
        key={`correlation:${correlationId ?? ""}`}
        id="debug-correlation"
        label="Correlation"
        placeholder="process id"
        value={correlationId}
        onApply={(next) => navigate({ ...active, correlationId: next })}
      />

      <TextFilter
        key={`related:${relatedId ?? ""}`}
        id="debug-related"
        label="Related id"
        placeholder="task / row id"
        value={relatedId}
        onApply={(next) => navigate({ ...active, relatedId: next })}
      />

      {/* The transitive facet: follows correlation + related-row links both ways,
          so one id surfaces the whole story (turn → task → fires → messages). */}
      <TextFilter
        key={`flow:${flow ?? ""}`}
        id="debug-flow"
        label="Flow"
        placeholder="any linked id"
        value={flow}
        onApply={(next) => navigate({ ...active, flow: next })}
      />
    </div>
  );
}
