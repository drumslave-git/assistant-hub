"use client";

import { Plug } from "lucide-react";
import type { ReactNode } from "react";

import { Badge, Button, Combobox, Field, Select } from "@/components/ui";
import type { Backend } from "@/features/backends/server/schema";
import type { ModelsState, ProbeState } from "./connection";

/** All the wording one role section differs by. */
export interface RoleSectionLabels {
  /** Feature intro paragraph shown at the top of the tab. */
  intro: string;
  /** What this role's endpoint serves, shown under the backend select. */
  backendHint: string;
  modelLabel: string;
  modelHint: string;
  /** Placeholder for the empty model input, naming what "empty" means. */
  modelPlaceholder: string;
  testLabel?: string;
  testingLabel?: string;
}

/**
 * One role's configuration section (embeddings, images, speech, audio, vision,
 * browser agent — and chat, which differs only by having no inherit option):
 * the backend select over the shared catalog, the searchable model combobox
 * fed from that backend's model list, and the optional probe row. One shell for
 * every tab so the seven cannot drift apart.
 */
export function RoleSection<T>({
  idPrefix,
  labels,
  backends,
  backendId,
  onBackendChange,
  /** Label for the null-backend option ("Same backend as chat …"); null hides it (chat itself). */
  inheritLabel,
  model,
  onModelChange,
  models,
  freeTextModel,
  modelWarning,
  probe,
  renderOk,
  onTest,
  testDisabled,
  children,
}: {
  /** Stable field-id prefix, e.g. "embedding" → `embeddingBackend`, `embeddingModel`. */
  idPrefix: string;
  labels: RoleSectionLabels;
  /** The saved backend catalog the select offers. */
  backends: Backend[];
  /** This role's own backend id; null = inherit the chat backend. */
  backendId: string | null;
  onBackendChange: (next: string | null) => void;
  inheritLabel: string | null;
  model: string;
  onModelChange: (next: string) => void;
  /** Model list state for this role's *effective* backend (null = nothing to list). */
  models: ModelsState | null;
  /** Free-text model entry with suggestions (whisper-class servers list nothing). */
  freeTextModel?: boolean;
  /** Rendered under the model control when the current selection is known stale. */
  modelWarning?: string | null;
  /** Probe row (omit all three for roles verified by the model list alone). */
  probe?: ProbeState<T>;
  renderOk?: (result: T) => ReactNode;
  onTest?: () => void;
  testDisabled?: boolean;
  /** Extra role-specific fields, rendered between the model select and the probe row. */
  children?: ReactNode;
}) {
  const modelOptions = models?.kind === "ok" ? models.models : [];
  // Keep the saved selection pickable when the list does not (yet) contain it —
  // an unreachable endpoint must not blank out a working selection — unless it
  // is provably stale, in which case re-offering it would offer exactly the
  // value the save is about to clear.
  const options =
    model && !modelOptions.includes(model) && !modelWarning ? [model, ...modelOptions] : modelOptions;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{labels.intro}</p>

      <Field id={`${idPrefix}Backend`} label="Backend" hint={labels.backendHint}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={backendId ?? ""}
            onChange={(e) => onBackendChange(e.target.value === "" ? null : e.target.value)}
          >
            {inheritLabel !== null ? <option value="">{inheritLabel}</option> : null}
            {inheritLabel === null && backendId === null ? (
              <option value="">Select a backend…</option>
            ) : null}
            {backends.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.name} — {backend.baseUrl}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field id={`${idPrefix}Model`} label={labels.modelLabel} hint={labels.modelHint}>
        {({ id, describedBy }) => (
          <div className="space-y-2">
            <Combobox
              id={id}
              aria-describedby={describedBy}
              value={model}
              onChange={onModelChange}
              options={options}
              placeholder={labels.modelPlaceholder}
              freeText={freeTextModel}
            />
            {models?.kind === "loading" ? (
              <p className="text-sm text-faint">Loading models…</p>
            ) : null}
            {models?.kind === "error" ? (
              <p className="text-sm text-danger">
                Could not list models from this backend: {models.message}
              </p>
            ) : null}
          </div>
        )}
      </Field>

      {modelWarning ? <p className="text-sm text-warning">{modelWarning}</p> : null}

      {children}

      {probe && onTest ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={probe.kind === "testing" || testDisabled}
            leftIcon={<Plug className="h-4 w-4" />}
          >
            {probe.kind === "testing"
              ? (labels.testingLabel ?? "Testing…")
              : (labels.testLabel ?? "Test connection")}
          </Button>
          {probe.kind === "ok" && renderOk ? (
            <Badge tone="success" dot>
              {renderOk(probe.result)}
            </Badge>
          ) : null}
          {probe.kind === "error" ? (
            <span className="text-sm text-danger">{probe.message}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
