import "server-only";

/**
 * A tiny enqueue signal, decoupling the MCP tool / Route Handler (which insert a
 * queued run) from the runner (which drains the queue). The runner registers a
 * listener at boot; enqueuers call {@link emitRunEnqueued} after inserting, so a
 * new run is picked up immediately instead of waiting for a poll. Held on a
 * `globalThis` singleton so it survives Next bundle re-evaluation and HMR.
 */

type Listener = () => void;

const STORE_KEY = Symbol.for("llm-tg-bot.browser-agent.signal");

function store(): { listener: Listener | null } {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: { listener: Listener | null } };
  if (!g[STORE_KEY]) g[STORE_KEY] = { listener: null };
  return g[STORE_KEY];
}

/** Register (or clear with null) the runner's pump trigger. */
export function setRunEnqueuedListener(listener: Listener | null): void {
  store().listener = listener;
}

/** Signal that a run was enqueued, so the runner drains the queue now. */
export function emitRunEnqueued(): void {
  store().listener?.();
}
