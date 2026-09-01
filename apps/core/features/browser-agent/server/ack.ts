import "server-only";

/**
 * Tracks the chat's "on it" acknowledgement for each enqueued browsing run, so
 * the runner can delete it once the run reports for itself (user decision,
 * 2026-08-01: the ack is transient chatter — sent silent, removed when the run
 * settles). In-memory on a `globalThis` singleton (same pattern as `signal.ts` /
 * `live-state.ts`): the reply pipeline, the runner, and the enqueuing tool all
 * live in one process, and losing an entry over a restart merely leaves one ack
 * message standing — cosmetic, not data loss.
 *
 * Both sides can win the race. Normally the ack is registered while the run is
 * still browsing and the runner takes it at settle. But a fast run can settle
 * before the reply carrying the ack is even delivered — the runner then leaves a
 * `settled` marker, and {@link registerRunAck} answers `"settled"` so the caller
 * deletes the just-sent message immediately instead of letting it stand forever.
 */

interface AckEntry {
  chatId: string;
  messageIds: number[];
  /** Set when the run settled with no ack registered yet (epoch ms, for sweeping). */
  settledAt: number | null;
}

const STORE_KEY = Symbol.for("assistant-hub.browser-agent.ack");

/** Settled markers whose ack never arrived are dropped after this long. */
const STALE_MARKER_MS = 60 * 60 * 1000;

function store(): Map<string, AckEntry> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, AckEntry> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

/** Drop settled markers that never saw a registration (e.g. the reply errored). */
function sweep(entries: Map<string, AckEntry>): void {
  const cutoff = Date.now() - STALE_MARKER_MS;
  for (const [runId, entry] of entries) {
    if (entry.settledAt != null && entry.settledAt < cutoff) entries.delete(runId);
  }
}

/**
 * Record one delivered acknowledgement message for a run. Returns `"stored"`
 * when the runner will delete it at settle, or `"settled"` when the run already
 * finished — the caller must then delete the message itself, right now.
 */
export function registerRunAck(
  runId: string,
  chatId: string,
  messageId: number,
): "stored" | "settled" {
  const entries = store();
  sweep(entries);
  const existing = entries.get(runId);
  if (existing?.settledAt != null) {
    // Marker kept (a reply may deliver several chunks, each registering):
    // every late registration must learn the run is over. Swept by age.
    return "settled";
  }
  if (existing) {
    existing.messageIds.push(messageId);
  } else {
    entries.set(runId, { chatId, messageIds: [messageId], settledAt: null });
  }
  return "stored";
}

/**
 * Take a run's acknowledgement for deletion (called by the runner at settle).
 * When none was registered yet, leaves a settled marker so a late registration
 * knows to delete immediately, and returns null.
 */
export function takeRunAck(runId: string): { chatId: string; messageIds: number[] } | null {
  const entries = store();
  sweep(entries);
  const entry = entries.get(runId);
  if (entry && entry.messageIds.length > 0) {
    entries.delete(runId);
    return { chatId: entry.chatId, messageIds: entry.messageIds };
  }
  entries.set(runId, { chatId: "", messageIds: [], settledAt: Date.now() });
  return null;
}

/** Test-only: clear all entries (the store survives module reloads by design). */
export function __resetRunAcksForTests(): void {
  store().clear();
}
