"use client";

import { Plug } from "lucide-react";
import type { ReactNode } from "react";

import { Badge, Button, Field, Input, Select, Switch } from "@/components/ui";

import { BackendField } from "./BackendField";
import type { BackendConnection, ProbeState, SecretField } from "./connection";

/** All the wording one backend section differs by. */
export interface ConnectionSectionLabels {
  /** Feature intro paragraph shown at the top of the tab. */
  intro: string;
  switchLabel: string;
  switchHint: string;
  urlLabel: string;
  urlHint: string;
  urlPlaceholder: string;
  urlMissingError: string;
  keyLabel: string;
  modelLabel: string;
  modelHint: string;
  /** The "feature off" option, e.g. "No embedding model (semantic recall off)". */
  modelEmptyOption: string;
  testLabel: string;
  testingLabel: string;
}

/**
 * One optional-backend connection section (embeddings, images): the
 * separate-backend switch, its URL + key when on, the model select, and the
 * probe row. The embeddings and images tabs used to be two hand-kept copies of
 * this exact shape.
 */
export function ConnectionSection<T>({
  idPrefix,
  labels,
  conn,
  secret,
  models,
  probe,
  renderOk,
  onTest,
  modelWarning,
  freeTextModel,
  children,
}: {
  /** Stable field-id prefix, e.g. "embedding" → `embeddingBaseUrl`, `embeddingModel`. */
  idPrefix: string;
  labels: ConnectionSectionLabels;
  conn: BackendConnection;
  secret: SecretField;
  models: string[];
  probe: ProbeState<T>;
  /** The success badge content for this probe's payload. */
  renderOk: (result: T) => ReactNode;
  onTest: () => void;
  /**
   * Rendered under the model control when the current selection is known to be
   * stale (e.g. not served by the freshly-tested LLM endpoint this section
   * reuses), so the operator learns it on the tab where they can fix it.
   */
  modelWarning?: string | null;
  /**
   * Render the model as a free-text input (with `models` as datalist
   * suggestions) instead of a strict select. For backends whose model ids the
   * endpoint cannot list (whisper-class servers often have no `/v1/models`).
   */
  freeTextModel?: boolean;
  /** Extra backend-specific fields, rendered between the model select and the probe row. */
  children?: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{labels.intro}</p>

      <Field id={`${idPrefix}SeparateBackend`} label={labels.switchLabel} hint={labels.switchHint}>
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={conn.separate}
              onChange={(e) => conn.setSeparate(e.target.checked)}
            />
            <span className="text-sm text-muted">
              {conn.separate ? "Own backend" : "Same backend as the LLM"}
            </span>
          </div>
        )}
      </Field>

      {/* Only shown when the operator asked for a separate backend — otherwise there
          is nothing to fill in, and an empty URL field would invite the question of
          what a blank one means. */}
      {conn.separate ? (
        <>
          <Field
            id={`${idPrefix}BaseUrl`}
            label={labels.urlLabel}
            hint={labels.urlHint}
            error={conn.urlMissing ? labels.urlMissingError : undefined}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="url"
                inputMode="url"
                required
                value={conn.baseUrl}
                onChange={(e) => conn.setBaseUrl(e.target.value)}
                placeholder={labels.urlPlaceholder}
              />
            )}
          </Field>

          <Field
            id={`${idPrefix}ApiKey`}
            label={labels.keyLabel}
            hint="Optional — required only if that host needs one. Stored securely; never shown again."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                value={secret.value}
                onChange={(e) => secret.set(e.target.value)}
                placeholder={secret.placeholderFor("optional")}
              />
            )}
          </Field>
        </>
      ) : null}

      {/* Only meaningful for a section with its own host: one that reuses the LLM
          connection inherits that endpoint's backend along with its key, exactly
          as the server resolves it. Showing a second control here would offer a
          choice the runtime does not honor. */}
      {conn.separate ? (
        <BackendField
          idPrefix={idPrefix}
          value={conn.backend}
          onChange={conn.setBackend}
          baseUrl={conn.resolvedUrl}
        />
      ) : null}

      <Field id={`${idPrefix}Model`} label={labels.modelLabel} hint={labels.modelHint}>
        {({ id, describedBy }) =>
          freeTextModel ? (
            <>
              <Input
                id={id}
                aria-describedby={describedBy}
                value={conn.model}
                onChange={(e) => conn.setModel(e.target.value)}
                placeholder={labels.modelEmptyOption}
                list={`${idPrefix}ModelOptions`}
              />
              {models.length > 0 ? (
                <datalist id={`${idPrefix}ModelOptions`}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              ) : null}
            </>
          ) : (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={conn.model}
              disabled={models.length === 0}
              onChange={(e) => conn.setModel(e.target.value)}
            >
              <option value="">{labels.modelEmptyOption}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          )
        }
      </Field>

      {modelWarning ? <p className="text-sm text-warning">{modelWarning}</p> : null}

      {children}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={probe.kind === "testing" || conn.model.trim() === "" || conn.urlMissing}
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {probe.kind === "testing" ? labels.testingLabel : labels.testLabel}
        </Button>
        {probe.kind === "ok" ? (
          <Badge tone="success" dot>
            {renderOk(probe.result)}
          </Badge>
        ) : null}
        {probe.kind === "error" ? (
          <span className="text-sm text-danger">{probe.message}</span>
        ) : null}
      </div>
    </div>
  );
}
