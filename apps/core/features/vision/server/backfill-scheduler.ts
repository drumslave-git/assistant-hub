import "server-only";

import { FEATURES } from "@/lib/features";
import { createIdleScheduler, type IdleJobStatus, type IdleScheduler } from "@/server/jobs/idle-scheduler";
import { publishEvent } from "@/server/realtime/hub";

import { resolveSourceMediaBrowse } from "@/server/turn/tg-media";

import { runVisionBackfill } from "./backfill";
import { resolveDescribeDeps } from "./service";

/**
 * In-process idle scheduler for the vision backfill job, owned by a single
 * `globalThis` singleton (like the bot manager and MCP registry) so there is
 * exactly one per process and it survives HMR.
 *
 * The scheduler runs the backfill only after the bot has been quiet for
 * {@link DEBOUNCE_MS}; `pokeVisionBackfill()` is called on every handled message
 * to re-arm the wait and abort a batch in flight, so backfill never competes
 * with a live reply. The LLM connection is read fresh per run (a settings change
 * takes effect on the next run without a restart).
 */

/** Idle period before a backfill run fires. A code constant, not a setting. */
const DEBOUNCE_MS = 45_000;

const FEATURE = FEATURES["vision-backfill"];
const STORE_KEY = Symbol.for("llm-tg-bot.vision.backfill-scheduler");

function scheduler(): IdleScheduler {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: IdleScheduler };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createIdleScheduler({
      name: "vision-backfill",
      debounceMs: DEBOUNCE_MS,
      onStatusChange: () => publishEvent(FEATURE.realtimeTopic),
      run: async (ctx) => {
        // The pending rows live with the owning source since the split.
        const source = resolveSourceMediaBrowse();
        if (!source) return { summary: "telegram service not configured (TG_API_URL / INTERNAL_API_TOKEN)" };
        const deps = await resolveDescribeDeps("background").catch(() => null);
        if (!deps) return { summary: "LLM not configured" };
        const result = await runVisionBackfill(deps, source, {
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
 * Start the backfill scheduler: arm an initial run so any backlog left from
 * before boot is cleared during the first quiet window. Idempotent.
 */
export function startVisionBackfill(): void {
  scheduler().onActivity();
}

/** Stop the scheduler (shutdown): clear the timer and abort a running batch. */
export function stopVisionBackfill(): void {
  scheduler().stop();
}

/** Signal live bot activity — re-arm the idle debounce and yield a running batch. */
export function pokeVisionBackfill(): void {
  scheduler().onActivity();
}

/** Trigger a run as soon as possible (dashboard "Run now"). */
export function runVisionBackfillNow(): void {
  scheduler().runNow();
}

/** Current scheduler status — cheap and synchronous, safe for status probes. */
export function getVisionBackfillStatus(): IdleJobStatus {
  return scheduler().getStatus();
}
