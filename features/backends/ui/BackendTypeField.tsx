"use client";

import { useCallback, useState } from "react";

import { Button, Field, Select } from "@/components/ui";
import { readApiError } from "@/lib/api-error";
import { LLM_BACKENDS, type LlmBackendId } from "@/lib/llm-backend";

/**
 * The backend-type selector: which inference server answers at this endpoint,
 * plus a Detect button that asks the endpoint to name itself.
 *
 * Detection only ever *suggests*. The operator picks (user decision,
 * 2026-08-07): a control that silently changed how requests are built would be
 * the same class of bug the backend-normalization layer exists to prevent.
 */

/** What the detect endpoint answers with. */
interface Detection {
  backend: LlmBackendId | null;
  detail: string;
}

type DetectState =
  | { kind: "idle" }
  | { kind: "detecting" }
  | { kind: "done"; detail: string; applied: boolean }
  | { kind: "error"; message: string };

export function BackendTypeField({
  idPrefix,
  value,
  onChange,
  /** The URL to fingerprint. Null while the form has no usable URL yet. */
  baseUrl,
  hint,
}: {
  /** Stable field-id prefix, e.g. "new" → `newType`. */
  idPrefix: string;
  value: LlmBackendId;
  onChange: (next: LlmBackendId) => void;
  baseUrl: string | null;
  hint?: string;
}) {
  const [state, setState] = useState<DetectState>({ kind: "idle" });
  const selected = LLM_BACKENDS.find((b) => b.id === value);

  const detect = useCallback(async () => {
    if (!baseUrl?.trim()) return;
    setState({ kind: "detecting" });
    try {
      const res = await fetch("/api/backends/detect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim() }),
      });
      if (!res.ok) {
        setState({ kind: "error", message: await readApiError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: Detection };
      // Applied only when the probe actually identified something, and reported
      // either way — a silent no-op reads as a broken button.
      if (data.backend) onChange(data.backend);
      setState({ kind: "done", detail: data.detail, applied: Boolean(data.backend) });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach the server" });
    }
  }, [baseUrl, onChange]);

  return (
    <Field
      id={`${idPrefix}Type`}
      label="Server type"
      hint={hint ?? selected?.hint ?? "Which inference server answers at this endpoint."}
    >
      {({ id, describedBy }) => (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Select
              id={id}
              aria-describedby={describedBy}
              value={value}
              onChange={(e) => {
                onChange(e.target.value as LlmBackendId);
                setState({ kind: "idle" });
              }}
            >
              {LLM_BACKENDS.map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.label}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              onClick={detect}
              disabled={!baseUrl?.trim() || state.kind === "detecting"}
            >
              {state.kind === "detecting" ? "Detecting…" : "Detect"}
            </Button>
          </div>
          {state.kind === "done" ? (
            <p className={`text-sm ${state.applied ? "text-success" : "text-muted"}`}>
              {state.applied ? `Detected ${state.detail}` : state.detail}
            </p>
          ) : null}
          {state.kind === "error" ? <p className="text-sm text-danger">{state.message}</p> : null}
        </div>
      )}
    </Field>
  );
}
