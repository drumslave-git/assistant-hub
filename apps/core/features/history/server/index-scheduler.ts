import "server-only";

import { FEATURES } from "@/lib/features";
import {
  createIdleScheduler,
  type IdleJobStatus,
  type IdleScheduler,
} from "@/server/jobs/idle-scheduler";
import { publishEvent } from "@/server/realtime/hub";

import { resolveSourceContent } from "@/server/source/tg-content";

import { runMessageIndexing } from "./index-messages";

/**
 * In-process idle scheduler for the message search-indexing job, owned by a
 * single `globalThis` singleton (like the bot manager, the MCP registry and the
 * vision backfill) so there is exactly one per process and it survives HMR.
 *
 * The debounce is longer than the vision backfill's, and deliberately so: the two
 * jobs share one quiet window and one endpoint, and indexing *depends* on the
 * backfill's output — a photo described during a quiet window should be indexed
 * with its description, not a minute before it exists. Waiting longer means the
 * usual case is one indexing pass that picks up everything the describer just
 * wrote, rather than two passes over the same rows.
 */

/** Idle period before an indexing run fires. A code constant, not a setting. */
const DEBOUNCE_MS = 90_000;

const FEATURE = FEATURES["history-index"];
const STORE_KEY = Symbol.for("assistant-hub.history.index-scheduler");

function scheduler(): IdleScheduler {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: IdleScheduler };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createIdleScheduler({
      name: "history-index",
      debounceMs: DEBOUNCE_MS,
      onStatusChange: () => publishEvent(FEATURE.realtimeTopic),
      run: async (ctx) => {
        // The mirror and the index live with the owning source.
        if (!resolveSourceContent()) {
          return { summary: "telegram service not configured (TG_API_URL / INTERNAL_API_TOKEN)" };
        }
        const result = await runMessageIndexing({
          isAborted: ctx.isAborted,
          onProgress: ctx.reportProgress,
        });
        return { summary: result.summary };
      },
    });
  }
  return g[STORE_KEY];
}

/**
 * Start the indexing scheduler: arm an initial run so any backlog left from
 * before boot is indexed during the first quiet window. Idempotent.
 */
export function startMessageIndexing(): void {
  scheduler().onActivity();
}

/** Stop the scheduler (shutdown): clear the timer and abort a running batch. */
export function stopMessageIndexing(): void {
  scheduler().stop();
}

/** Signal live bot activity — re-arm the idle debounce and yield a running batch. */
export function pokeMessageIndexing(): void {
  scheduler().onActivity();
}

/** Trigger a run as soon as possible (dashboard "Index now"). */
export function runMessageIndexingNow(): void {
  scheduler().runNow();
}

/** Current scheduler status — cheap and synchronous, safe for status probes. */
export function getMessageIndexingStatus(): IdleJobStatus {
  return scheduler().getStatus();
}
