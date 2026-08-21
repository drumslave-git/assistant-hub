import "server-only";

import type { BrowserRunLiveState } from "../types";

/**
 * Ephemeral per-run live state — what a running run is doing *right now* and its
 * download progress. Deliberately NOT persisted: it changes many times a second
 * during a download, and a run that dies mid-flight is swept to `failed` anyway,
 * so durability buys nothing. The runner writes it; the run-detail API reads it
 * (same process). Held on a `globalThis` singleton so it survives Next bundle
 * re-evaluation / HMR, like the other in-process singletons.
 */

const STORE_KEY = Symbol.for("llm-tg-bot.browser-agent.live-state");

function store(): Map<string, BrowserRunLiveState> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, BrowserRunLiveState> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

/** Set the in-flight action label for a run (clears any stale progress line). */
export function setLiveAction(runId: string, action: string | null): void {
  const s = store();
  const prev = s.get(runId);
  s.set(runId, { currentAction: action, progress: action == null ? null : (prev?.progress ?? null) });
}

/** Update the live download-progress line for a run (kept until the next action). */
export function setLiveProgress(runId: string, progress: string | null): void {
  const s = store();
  const prev = s.get(runId) ?? { currentAction: null, progress: null };
  s.set(runId, { ...prev, progress });
}

/** The live state for a run, or null when it holds none (settled / never ran). */
export function getLiveState(runId: string): BrowserRunLiveState | null {
  return store().get(runId) ?? null;
}

/** Drop a run's live state (on settle). */
export function clearLiveState(runId: string): void {
  store().delete(runId);
}
