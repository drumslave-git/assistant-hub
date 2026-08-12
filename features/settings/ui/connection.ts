"use client";

import { useCallback, useRef, useState } from "react";

import { readApiError } from "@/lib/api-error";

/**
 * Shared state machines for the settings form. The probe flow and the
 * write-only secret input each have one definition here; the per-backend model
 * cache is what feeds every role tab's searchable model select.
 */

export { readApiError as readError };

/** One connection probe: idle → testing → ok (with the probe's payload) | error. */
export type ProbeState<T> =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; result: T }
  | { kind: "error"; message: string };

/**
 * A POST-JSON probe against one settings test endpoint. `run` resolves with the
 * endpoint's `data` payload on success and null on failure; the state machine
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
          setState({ kind: "error", message: await readApiError(res) });
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

/** What is known about one backend's model list. */
export type ModelsState =
  | { kind: "loading" }
  | { kind: "ok"; models: string[] }
  | { kind: "error"; message: string };

/**
 * Per-backend model lists for the role dropdowns, seeded with the server
 * preload and fetched on demand for any backend the operator points a role at
 * afterwards. One cache for the whole form: several roles usually share one
 * backend, and each list should be fetched once, not per tab.
 *
 * An empty preloaded list is treated as "unknown" rather than cached — the
 * preload cannot distinguish an endpoint that serves nothing from one that was
 * unreachable, and a client fetch turns that into a real answer (or a visible
 * error) the moment a role actually needs the list.
 */
export function useBackendModels(preloaded: Record<string, string[]>) {
  const [cache, setCache] = useState<Record<string, ModelsState>>(() =>
    Object.fromEntries(
      Object.entries(preloaded)
        .filter(([, models]) => models.length > 0)
        .map(([id, models]) => [id, { kind: "ok", models } as ModelsState]),
    ),
  );
  // Fetches already in flight; a ref so effects/renders cannot double-fire one.
  const inFlight = useRef(new Set<string>());

  const load = useCallback(async (backendId: string, force = false) => {
    if (inFlight.current.has(backendId)) return;
    inFlight.current.add(backendId);
    setCache((prev) => ({ ...prev, [backendId]: { kind: "loading" } }));
    try {
      const res = await fetch(`/api/backends/${encodeURIComponent(backendId)}/models`);
      if (!res.ok) {
        const message = await readApiError(res);
        setCache((prev) => ({ ...prev, [backendId]: { kind: "error", message } }));
        return;
      }
      const { data } = (await res.json()) as { data: { models: string[] } };
      setCache((prev) => ({ ...prev, [backendId]: { kind: "ok", models: data.models } }));
    } catch {
      setCache((prev) => ({
        ...prev,
        [backendId]: { kind: "error", message: "Network error — could not reach the server" },
      }));
    } finally {
      inFlight.current.delete(backendId);
    }
    void force;
  }, []);

  /** Ensure a backend's list is known (no-op when cached or loading). */
  const ensure = useCallback(
    (backendId: string | null) => {
      if (!backendId) return;
      if (cache[backendId]) return;
      void load(backendId);
    },
    [cache, load],
  );

  /** Re-fetch a backend's list (after an explicit "refresh" action). */
  const refresh = useCallback(
    (backendId: string | null) => {
      if (!backendId) return;
      void load(backendId, true);
    },
    [load],
  );

  const get = useCallback(
    (backendId: string | null): ModelsState | null => (backendId ? (cache[backendId] ?? null) : null),
    [cache],
  );

  /** Feed a list obtained elsewhere (a passed "Test connection") into the cache. */
  const prime = useCallback((backendId: string | null, models: string[]) => {
    if (!backendId) return;
    setCache((prev) => ({ ...prev, [backendId]: { kind: "ok", models } }));
  }, []);

  return { get, ensure, refresh, prime };
}

export type BackendModels = ReturnType<typeof useBackendModels>;
