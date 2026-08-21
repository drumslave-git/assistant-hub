import "server-only";

import { computeNextScheduleRun } from "@/features/tasks/schedule";
import {
  DEFAULT_DAILY_JOBS_RUN_TIME,
  getDailyJobsRunTime,
  getTimezone,
} from "@/features/settings/server/service";
import type { FeatureDescriptor } from "@/lib/features";
import { publishEvent } from "@/server/realtime/hub";

import { isDailyRunDue } from "./daily-due";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalRunContext,
  type IntervalScheduler,
} from "./interval-scheduler";

/**
 * The recorded background-job model, made once: a fixed-interval ticker that
 * asks every minute whether the configured local run time
 * (`settings.daily_jobs_run_time`, in the operator timezone — shared by every
 * daily job) has passed today without a run, and if so does the night's work.
 * "Run now" forces the next tick regardless of the clock.
 *
 * The summary/memory/self-improvement/analytics schedulers each used to carry a
 * private copy of this ~100-line shape (`globalThis` store, due check, "waiting
 * (next run …)" summaries, base job info); a feature now supplies only its
 * `runJob` and whatever extra info fields its card shows on top of
 * {@link DailyJobInfoBase}. The advisory lock stays inside `runJob` — which
 * lock, and what runs under it, is the feature's own contract.
 *
 * State is held on a `globalThis` singleton per job name, so there is exactly
 * one ticker per process and it survives dev hot-reload.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 60_000;

/** The shared half of every daily job card; features add their own fields. */
export interface DailyJobInfoBase {
  status: IntervalJobStatus;
  /** ISO time of the next daily run, or null when the run time is invalid. */
  nextRunAt: string | null;
  /** Configured local run time (`HH:MM`) and the timezone it is read in. */
  runTime: string;
  timezone: string;
  /** Outcome of the last *actual* run, kept apart from the ticker's "waiting" summaries. */
  lastResult: { at: string; summary: string } | null;
}

export interface DailySchedulerConfig {
  /** Unique job name — the interval scheduler's name and the singleton key. */
  name: string;
  /** Feature whose realtime topic (if any) status changes publish to. */
  feature: FeatureDescriptor;
  /** The night's work; resolves to the run summary shown on the card. */
  runJob: (ctx?: IntervalRunContext) => Promise<string>;
}

export interface DailyScheduler {
  /** Start the daily poller (boot). Idempotent. */
  start(): void;
  /** Stop the poller (shutdown). */
  stop(): void;
  /** Force a run as soon as possible (dashboard "Run now"). */
  runNow(): Promise<void>;
  /** The shared half of the job card info — spread it and add feature fields. */
  getBaseInfo(): Promise<DailyJobInfoBase>;
}

interface DailyStore {
  scheduler: IntervalScheduler;
  /** When the last due-triggered daily run happened (in-memory by design). */
  lastDailyRunAt: Date | null;
  /** Set by "Run now" — the next tick runs regardless of the clock. */
  forceNext: boolean;
  lastResult: { at: string; summary: string } | null;
}

export function createDailyScheduler(config: DailySchedulerConfig): DailyScheduler {
  const storeKey = Symbol.for(`llm-tg-bot.daily-scheduler.${config.name}`);

  /** One poll tick: run when forced, or when the daily wall-clock time is due. */
  async function runTick(s: DailyStore, ctx?: IntervalRunContext): Promise<{ summary: string }> {
    const forced = s.forceNext;
    s.forceNext = false;

    if (!forced) {
      const [timezone, runTime] = await Promise.all([
        getTimezone().catch(() => "UTC"),
        getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
      ]);
      const now = new Date();
      if (
        !isDailyRunDue({ timeOfDay: runTime, now, timeZone: timezone, lastRunAt: s.lastDailyRunAt })
      ) {
        const next = computeNextScheduleRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
        return { summary: `waiting${next ? ` (next run ${next.toISOString()})` : ""}` };
      }
      s.lastDailyRunAt = now;
    }

    const summary = await config.runJob(ctx);
    s.lastResult = { at: new Date().toISOString(), summary };
    return { summary };
  }

  function store(): DailyStore {
    const g = globalThis as typeof globalThis & { [key: symbol]: DailyStore | undefined };
    if (!g[storeKey]) {
      const s: DailyStore = {
        lastDailyRunAt: null,
        forceNext: false,
        lastResult: null,
        scheduler: createIntervalScheduler({
          name: config.name,
          tickMs: TICK_MS,
          onStatusChange: () => {
            if (config.feature.realtimeTopic) {
              publishEvent(config.feature.realtimeTopic, { feature: config.feature.id });
            }
          },
          run: (ctx) => runTick(s, ctx),
        }),
      };
      g[storeKey] = s;
    }
    return g[storeKey]!;
  }

  return {
    start: () => store().scheduler.start(),
    stop: () => store().scheduler.stop(),
    runNow: () => {
      const s = store();
      s.forceNext = true;
      return s.scheduler.runNow();
    },
    async getBaseInfo(): Promise<DailyJobInfoBase> {
      const s = store();
      const [timezone, runTime] = await Promise.all([
        getTimezone().catch(() => "UTC"),
        getDailyJobsRunTime().catch(() => DEFAULT_DAILY_JOBS_RUN_TIME),
      ]);
      const now = new Date();
      const due = isDailyRunDue({
        timeOfDay: runTime,
        now,
        timeZone: timezone,
        lastRunAt: s.lastDailyRunAt,
      });
      // When today's run is still owed, the next instant is "now" (the next
      // tick); otherwise it is the next daily occurrence.
      const next = due
        ? now
        : computeNextScheduleRun({ scheduleKind: "daily", timeOfDay: runTime }, now, timezone);
      return {
        status: s.scheduler.getStatus(),
        nextRunAt: next ? next.toISOString() : null,
        runTime,
        timezone,
        lastResult: s.lastResult,
      };
    },
  };
}
