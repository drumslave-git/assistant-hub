"use client";

import { useCallback, useState } from "react";

import type { ApiErrorBody } from "@/lib/api-error";
import type { LlmBackendId } from "@/lib/llm-backend";

/**
 * Shared state machines for the settings connection sections. The form used to
 * carry three hand-rolled copies of the probe flow and five of the write-only
 * secret input; these hooks are the single definition of each.
 */

/** Read the error message out of a failed API response. */
export async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** One connection probe: idle → testing → ok (with the probe's payload) | error. */
export type ProbeState<T> =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; result: T }
  | { kind: "error"; message: string };

/**
 * A POST-JSON probe against one settings test endpoint. `run` resolves with the
 * endpoint's `data` payload on success (so a caller can also consume it — the
 * LLM probe feeds the model dropdowns) and null on failure; the state machine
 * is what the UI renders either way.
 */
export function useProbe<T>(endpoint: string) {
  const [state, setState] = useState<ProbeState<T>>({ kind: "idle" });

  const reset = useCallback(() => setState({ kind: "idle" }), []);

  const run = useCallback(
    async (body: unknown): Promise<T | null> => {
      setState({ kind: "testing" });
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setState({ kind: "error", message: await readError(res) });
          return null;
        }
        const { data } = (await res.json()) as { data: T };
        setState({ kind: "ok", result: data });
        return data;
      } catch {
        setState({ kind: "error", message: "Network error — could not reach the server" });
        return null;
      }
    },
    [endpoint],
  );

  return { state, run, reset };
}

/**
 * A write-only secret input: the stored value never round-trips, so the field
 * starts empty with a "configured" placeholder and only a value the operator
 * actually typed (`dirty`) is sent on save.
 */
export function useSecretField(configured: boolean) {
  const [value, setValue] = useState("");
  const [dirty, setDirty] = useState(false);

  return {
    value,
    dirty,
    set(next: string) {
      setValue(next);
      setDirty(true);
    },
    /** After a save: the secret is stored (or cleared) server-side; forget it here. */
    clear() {
      setValue("");
      setDirty(false);
    },
    /** Placeholder text: masked "configured" until the operator starts typing. */
    placeholderFor(empty: string): string {
      return configured && !dirty ? "•••••••• (configured)" : empty;
    },
    /** The value a dirty field contributes to the save patch (empty → null). */
    get patchValue(): string | null {
      return value.trim() === "" ? null : value.trim();
    },
  };
}

export type SecretField = ReturnType<typeof useSecretField>;

/**
 * State for one optional separate backend (embeddings, images): URL, the
 * "separate backend" switch derived from it, and the model id. A stored URL *is*
 * the separate-backend flag — the two can never disagree, so the switch is
 * derived from it rather than persisted alongside it. `onChange` fires on any
 * edit so the section's probe result can be invalidated.
 */
export function useBackendConnection(
  initial: { baseUrl: string | null; model: string | null; backend: LlmBackendId },
  onChange: () => void,
) {
  const [baseUrl, setBaseUrlState] = useState(initial.baseUrl ?? "");
  const [separate, setSeparateState] = useState(Boolean(initial.baseUrl));
  const [model, setModelState] = useState(initial.model ?? "");
  const [backend, setBackendState] = useState<LlmBackendId>(initial.backend);

  // The backend as configured right now: its own URL only when the operator
  // asked for a separate backend, otherwise "reuse the LLM connection" (null).
  // Used identically by the probe and the save, so a passing test is a test of
  // what will actually be stored.
  const resolvedUrl = separate && baseUrl.trim() !== "" ? baseUrl.trim() : null;
  const urlMissing = separate && baseUrl.trim() === "";

  return {
    baseUrl,
    separate,
    model,
    backend,
    resolvedUrl,
    urlMissing,
    setBaseUrl(next: string) {
      setBaseUrlState(next);
      onChange();
    },
    setSeparate(next: boolean) {
      setSeparateState(next);
      onChange();
    },
    setModel(next: string) {
      setModelState(next);
      onChange();
    },
    setBackend(next: LlmBackendId) {
      setBackendState(next);
      onChange();
    },
    /** Re-seed from the saved record after a successful save. */
    applySaved(saved: { baseUrl: string | null; model: string | null; backend: LlmBackendId }) {
      setBaseUrlState(saved.baseUrl ?? "");
      setSeparateState(Boolean(saved.baseUrl));
      setModelState(saved.model ?? "");
      setBackendState(saved.backend);
    },
  };
}

export type BackendConnection = ReturnType<typeof useBackendConnection>;
