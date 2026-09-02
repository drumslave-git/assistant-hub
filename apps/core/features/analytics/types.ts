/**
 * Client-safe analytics types — shared by the server services (the trace/metric
 * readers) and the dashboard UI. Pure: no server-only *runtime* import (the one type
 * import below is erased), so a Client Component can use them.
 */

import type { IntervalJobStatus } from "@/server/jobs/interval-scheduler";

import type { LlmCallKindId } from "./llm-call-kind";

/**
 * A bucketing granularity. Used for the chart axis inside a period, for the
 * `date_trunc` unit in SQL, and as the unit an insight row is stored at.
 *
 * `hour` is the base unit: the insight job scores conversation per chat-hour, and a
 * day-period chart plots 24 hourly points, so hour is the finest thing anything on
 * the dashboard is measured at.
 */
export type Granularity = "hour" | "day" | "week" | "month" | "year" | "all";

export const GRANULARITIES: Granularity[] = ["hour", "day", "week", "month", "year", "all"];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All time",
};

/**
 * A period a card can be pointed at. Narrower than {@link Granularity}: you select
 * *a day* and see its 24 hours, so `hour` is a chart axis, never a selection.
 */
export type PeriodUnit = "day" | "week" | "month" | "year" | "all";

export const PERIOD_UNITS: PeriodUnit[] = ["day", "week", "month", "year", "all"];

/**
 * The periods a **chart** offers. `all` is absent by design: it has no bounded axis
 * to plot, so it drew a single meaningless dot. Tiles and the insight cards keep it,
 * where a lifetime total is a real answer.
 */
export const CHART_PERIOD_UNITS: PeriodUnit[] = ["day", "week", "month", "year"];

/** One LLM round's cost, grouped by what the call was *for*. */
export interface CallKindStat {
  /** Which kind of call this is — `LLM_CALL_KINDS` turns it into a human label. */
  callKind: LlmCallKindId;
  /** Provider rounds counted. A tool-looping reply contributes one per round. */
  calls: number;
  /** Mean end-to-end latency in ms. */
  avgLatencyMs: number;
  /** Median latency in ms — the typical call. Null when no call reported latency. */
  latencyP50: number | null;
  /** 95th-percentile latency in ms — the slow tail. Null when no call reported latency. */
  latencyP95: number | null;
  /**
   * Total wall time this kind accounted for, in ms. The bottleneck ranking: a
   * 400 ms call made ten thousand times costs more than a 20 s call made twice, and
   * only this number says so.
   */
  totalLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Completion tokens per second of latency, or null when latency is unknown.
   *
   * **Not a model speed measurement.** The latency it divides by includes time
   * spent queued behind other work on a shared endpoint, so this reports how
   * busy the endpoint was while a model happened to be in use. A rarely-used
   * model that ran mostly during quiet periods out-scores the everyday one on
   * the same hardware. Measured 2026-08-07: a 26B model showed 2.3x the 12B's
   * rate here and lost to it on every call shape in a controlled benchmark.
   */
  tokensPerSec: number | null;
}

/**
 * One model's usage in the selected period, broken down by call kind.
 *
 * The model level deliberately carries no latency average: it would be a mean over
 * unlike kinds of work. It carries volume (rounds, tokens) and throughput — a ratio
 * of sums, which stays well-defined across a mix, though see
 * {@link CallKindStat.tokensPerSec} for what that ratio does and does not mean.
 * Latency lives on {@link callKinds}.
 */
export interface ModelStat {
  /** Clean model name (registry prefixes stripped). */
  model: string;
  /** Provider rounds counted, across every call kind. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  /** Completion tokens per second of latency, or null when latency is unknown. */
  tokensPerSec: number | null;
  /** This model's call kinds, most total time first. */
  callKinds: CallKindStat[];
}

/** One user's activity within the period. */
export interface UserStat {
  /** Scoped ref of the person (`tg:user:123`). */
  userRef: string;
  label: string;
  messages: number;
  /** Prompt tokens attributed to this user's turns. */
  tokens: number;
}

/** Which chat/user the reader asked for. */
export type MetricScopeKind = "global" | "chat" | "user";

/**
 * The filters one card carries. Every card owns its own set — the dashboard has no
 * single global filter, so two cards can show different periods side by side (this
 * week's mood next to last year's token trend) without one clobbering the other.
 */
export interface CardFilters {
  unit: PeriodUnit;
  /** The selected period's key: `2026-07-18`, `2026-07`, `2026`, or `all`. */
  anchor: string;
  /** One chat's scoped ref, or null for every chat. */
  chatRef: string | null;
  /** One person's scoped ref, or null for everyone. */
  userRef: string | null;
}

/** Where a card's data comes from — picks the calendar's availability source. */
export type MetricSource = "messages" | "traces" | "insights";

export const METRIC_SOURCES: MetricSource[] = ["messages", "traces", "insights"];

/** Everything a card's response carries about *what it is*, echoed back from the filters. */
export interface MetricContext {
  unit: PeriodUnit;
  anchor: string;
  timezone: string;
  scope: MetricScopeKind;
  chatRef: string | null;
  userRef: string | null;
}

/** Which time series a chart card is asking for. */
export type SeriesSection = "volume" | "tokens" | "users" | "mood";

export const SERIES_SECTIONS: SeriesSection[] = ["volume", "tokens", "users", "mood"];

/**
 * One line on a chart. `null` is a real gap (no data for that bucket), which is not
 * the same as `0` — an unscored hour has no mood, it does not have a mood of 0.
 */
export interface NamedSeries {
  name: string;
  data: (number | null)[];
}

/** A chart card's payload: the dense sub-bucket axis plus its lines. */
export interface SeriesPayload extends MetricContext {
  section: SeriesSection;
  /** The granularity the axis is bucketed at — one step finer than `unit`. */
  bucketUnit: Granularity;
  /** Bucket labels, oldest → newest. Every series' data is aligned to this. */
  buckets: string[];
  series: NamedSeries[];
  /** Fixed y-axis maximum where the metric has one (mood is 0–100). */
  yMax?: number;
}

/**
 * The traffic tiles' payload — the bot's workload in the period, read from traces.
 *
 * "Handled" is what the bot opened a trace for, which is not the same as every
 * message sent: a group message the bot was never addressed in is not work it did.
 * Raw message counts are the Message volume chart's job, from history.
 */
export interface TotalsPayload extends MetricContext {
  totals: {
    handled: number;
    replied: number;
    failed: number;
    tokensProcessed: number;
    tokensGenerated: number;
    activeUsers: number;
    images: number;
  };
}

/** The model-performance card's payload for one period. */
export interface ModelsPayload extends MetricContext {
  models: ModelStat[];
}

/** The top-users card's payload for one period. */
export interface TopUsersPayload extends MetricContext {
  users: UserStat[];
}

/** One sub-bucket's mood point, for the mood trend chart. */
export interface MoodPoint {
  bucket: string;
  moodScore: number;
  moodLabel: string;
}

/**
 * The mood of one period, and the points it is made of.
 *
 * Deliberately one payload rather than two endpoints: the Mood tile's number is the
 * message-weighted mean of exactly the points the trend chart draws. Computing them
 * separately let the tile and the chart disagree about the same period, which is the
 * one thing a dashboard must never do.
 */
export interface MoodPayload {
  /** Null when no sub-bucket in the period has been scored yet. */
  aggregate: {
    moodScore: number;
    moodLabel: string;
    /** Scored sub-buckets behind the number. */
    sourceUnits: number;
    messageCount: number;
  } | null;
  points: MoodPoint[];
}

/**
 * The LLM-derived insight for a selected period: the word of the period and the top
 * topic, plus the mood that the Mood card and the trend chart share.
 *
 * Always scoped to one chat. A cross-chat average of unrelated conversations answers
 * no question anyone asks, so there is no global variant.
 */
export interface PeriodInsight {
  unit: PeriodUnit;
  anchor: string;
  chatRef: string;
  wordOfPeriod: string;
  topTopic: string;
  mood: MoodPayload["aggregate"];
  /** Scored hours behind the roll-up. */
  sourceUnits: number;
  messageCount: number;
  model: string;
  computedAt: string;
}

/** Status + backlog info for the analytics insight job's dashboard card. */
export interface AnalyticsJobInfo {
  status: IntervalJobStatus;
  /** ISO time of the next daily run, or null when the run time is invalid. */
  nextRunAt: string | null;
  /** Configured local run time (`HH:MM`) and the timezone it is read in. */
  runTime: string;
  timezone: string;
  /** Outcome of the last actual run, or null when it has never run. */
  lastResult: { at: string; summary: string } | null;
  /** Chat-hours still awaiting an insight — the visible backlog. */
  pendingUnits: number;
  /** Whether an LLM is configured (else the job settles as a no-op). */
  llmConfigured: boolean;
  /**
   * Per-granularity, the buckets that hold scored hours — what "Regenerate" can be
   * pointed at. Empty lists mean there is nothing stored to drop.
   */
  regenerateBuckets: Record<Granularity, string[]>;
}
