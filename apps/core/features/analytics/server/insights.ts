import "server-only";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { normalizeModelName } from "@/features/self-improvement/model-name";
import { FEATURES } from "@/lib/features";
import type {
  ChatCompletionResult,
  ChatMessage,
  LlmCallTrace,
} from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import {
  requireSourceContent,
  type SourceContentClient,
} from "@/server/source/content";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { moodLabelForScore } from "../mood";
import { bucketKeyOfInstant, subBucketKeys, weekBucketOf } from "../period";
import type { Granularity } from "../types";
import {
  buildHourInsightRequest,
  buildPeriodRollupRequest,
  formatTranscript,
  HOUR_INSIGHT_PROMPT,
  parseHourInsight,
  parseRollupChoice,
  PERIOD_ROLLUP_PROMPT,
  type RollupChild,
} from "./prompt";
import {
  deleteInsightsForPeriod,
  getDaySummaryTopics,
  getHourMessages,
  listHourInsightsForPeriod,
  listHoursNeedingInsight,
  listPeriodInsights,
  type PendingInsightHour,
  upsertChatHourInsight,
  upsertPeriodInsight,
} from "./repository";
import {
  advanceInsightScanFloor,
  getInsightScanFloor,
  resetInsightScanFloor,
} from "./watermark";

/**
 * The analytics insight job.
 *
 * It scores each finished chat-**hour**'s mood, top topic, and word (one LLM call),
 * then rolls those hour rows up the calendar: hour → day → week/month → year → all
 * time, for every period a scored hour touches. That is what makes mood, "word of
 * the period", and "top topic" available at whatever period the dashboard is pointed
 * at — and, because the hour is the finest thing the dashboard plots, what lets a
 * day's mood curve exist at all.
 *
 * **Roll-ups are hierarchical, not flat.** A month is rolled up from its *days*, not
 * from its ~700 hours: reading every hour into every enclosing period would put a
 * year's worth of rows in one prompt. Each level reads only its immediate children,
 * so every call sees at most 31 entries regardless of how much history exists.
 *
 * The mood at every level is a deterministic message-weighted mean, so it never
 * depends on a fragile parse — and because a child's own mood is already the weighted
 * mean of *its* children, rolling up levels gives exactly the same number as
 * averaging the underlying hours directly. The word and topic are one cheap LLM pass
 * that *selects* among the children rather than writing new text.
 *
 * **Work is only ever added by an unscored hour.** A scored hour is final: the job
 * never re-reads it because its message count drifted, and never reconciles stored
 * roll-ups against what it thinks they should be. Both of those were self-healing
 * scans, and both made the nightly token spend a function of invisible state.
 * Rewriting a scored hour is an operator action — {@link regenerateAnalyticsInsights}
 * drops the rows, which re-arms them through the ordinary unscored-hour path.
 *
 * Fails **closed** per unit: an unusable model response leaves the stored row
 * untouched, and the hour stays owed for the next run.
 */

const FEATURE = FEATURES["analytics-insights"];

/** Safety valves on one run (not business rules) — bound a runaway backlog. */
const MAX_HOURS_PER_RUN = 500;
const MAX_PERIODS_PER_RUN = 800;

export interface AnalyticsInsightsDeps {
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  timeZone: string;
  now?: Date;
  /** Publish live per-hour / per-period progress (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: StoreDb;
  /** The owning source's content API; the default resolves from env. */
  content?: SourceContentClient;
}

export interface AnalyticsInsightsResult {
  unitsComputed: number;
  unitsFailed: number;
  periodsComputed: number;
  periodsFailed: number;
  summary: string;
}

const EMPTY: Omit<AnalyticsInsightsResult, "summary"> = {
  unitsComputed: 0,
  unitsFailed: 0,
  periodsComputed: 0,
  periodsFailed: 0,
};

interface PeriodTarget {
  granularity: Granularity;
  bucket: string;
  chatRef: string;
}

function targetKey(t: PeriodTarget): string {
  return `${t.granularity}|${t.bucket}|${t.chatRef}`;
}

/**
 * The order roll-ups must be computed in, coarsest last. A month reads its days, so
 * the days have to exist first; processing targets in this order is what makes one
 * pass sufficient.
 */
const GRANULARITY_ORDER: Granularity[] = ["hour", "day", "week", "month", "year", "all"];

/**
 * Which granularity a period rolls up **from**.
 *
 * Week and month both read days rather than week reading nothing and month reading
 * weeks: a week straddles month boundaries, so a month built from weeks would count
 * days outside itself. Both reading days keeps every period exactly the sum of its
 * own calendar range.
 */
const ROLLUP_CHILD: Record<Exclude<Granularity, "hour">, Granularity> = {
  day: "hour",
  week: "day",
  month: "day",
  year: "month",
  all: "year",
};

/** Every period bucket a (hour, chat) touches — hour/day/week/month/year/all. */
function periodsForHour(insightHour: string, chatRef: string): PeriodTarget[] {
  const date = insightHour.slice(0, 10);
  const [year, month] = date.split("-");
  const buckets: [Granularity, string][] = [
    ["hour", insightHour],
    ["day", date],
    ["week", weekBucketOf(date)],
    ["month", `${year}-${month}`],
    ["year", year],
    ["all", "all"],
  ];
  return buckets.map(([granularity, bucket]) => ({ granularity, bucket, chatRef }));
}

/** Message-weighted mean mood across a period's child rows. */
function weightedMood(children: { moodScore: number; messageCount: number }[]): number {
  const totalMsgs = children.reduce((a, c) => a + c.messageCount, 0);
  if (totalMsgs === 0) return 50;
  return Math.round(
    children.reduce((a, c) => a + c.moodScore * c.messageCount, 0) / totalMsgs,
  );
}

/** The (chat, hour) pairs owed a score right now. */
async function pendingHours(
  content: SourceContentClient,
  db: StoreDb,
  deps: AnalyticsInsightsDeps,
): Promise<PendingInsightHour[]> {
  const now = deps.now ?? new Date();
  const currentHour = bucketKeyOfInstant(now, "hour", deps.timeZone);
  const pending = await listHoursNeedingInsight(content, db, {
    timeZone: deps.timeZone,
    // The in-progress hour is excluded: scoring it would freeze a partial
    // conversation, and a scored hour is never re-read.
    currentHour,
    limit: MAX_HOURS_PER_RUN,
    floorHour: getInsightScanFloor(deps.timeZone) ?? undefined,
  });
  // The scan orders ascending, so its first find is the oldest owed hour
  // anywhere above the floor — everything below that (or below currentHour,
  // when nothing is owed) is proven scored. Remember it so the next scan does
  // not re-group the whole mirror.
  advanceInsightScanFloor({
    oldestPendingHour: pending[0]?.insightHour ?? null,
    currentHour,
    now,
    timeZone: deps.timeZone,
  });
  return pending;
}

/**
 * The nightly run: score whatever hours are owed and roll up the periods they touch.
 * Costs nothing when nothing is owed.
 */
export async function runAnalyticsInsights(
  deps: AnalyticsInsightsDeps,
): Promise<AnalyticsInsightsResult> {
  const db = deps.db ?? getStoreDb();
  const content = deps.content ?? requireSourceContent();
  const pending = await pendingHours(content, db, deps);
  if (pending.length === 0) return { ...EMPTY, summary: "nothing to compute" };
  return runInsightPass(deps, db, content, pending, {
    action: "insights",
    inputSummary: `${pending.length} hour(s) pending`,
  });
}

/**
 * Drop every insight covering a period and compute it again from the messages. The
 * operator's answer to a score that is wrong or was produced by a since-changed
 * prompt — and the only way a scored hour is ever re-read.
 *
 * Deletion is deliberately wider than the requested bucket: dropping an hour's score
 * invalidates every roll-up containing that hour, at every granularity. The re-score
 * then rebuilds exactly the periods the re-scored hours touch.
 */
export async function regenerateAnalyticsInsights(
  deps: AnalyticsInsightsDeps,
  params: { granularity: Granularity; bucket: string },
): Promise<AnalyticsInsightsResult> {
  const db = deps.db ?? getStoreDb();
  const content = deps.content ?? requireSourceContent();
  const dropped = await deleteInsightsForPeriod(db, params);
  // The drop just un-scored hours that may lie below the due-scan's floor — the
  // next scan must be unbounded so it sees them owed again.
  resetInsightScanFloor();
  const pending = await pendingHours(content, db, deps);
  if (pending.length === 0) {
    return {
      ...EMPTY,
      summary: `dropped ${dropped.units} hour score(s) and ${dropped.periods} roll-up(s); no finished hour to re-score`,
    };
  }
  return runInsightPass(deps, db, content, pending, {
    action: "regenerate",
    inputSummary: `${params.granularity} ${params.bucket}: dropped ${dropped.units} hour score(s), ${dropped.periods} roll-up(s); re-scoring ${pending.length} hour(s)`,
    dropped,
  });
}

/**
 * The scoring + roll-up pass shared by the nightly run and a regenerate. The two
 * differ only in how the work was chosen, so the LLM passes, the tracing, and the
 * failure handling live here once.
 */
async function runInsightPass(
  deps: AnalyticsInsightsDeps,
  db: StoreDb,
  content: SourceContentClient,
  pending: PendingInsightHour[],
  meta: { action: string; inputSummary: string; dropped?: { units: number; periods: number } },
): Promise<AnalyticsInsightsResult> {
  const trace = await startTrace({
    feature: FEATURE.id,
    action: meta.action,
    trigger: { kind: "system", actor: "analytics" },
    inputSummary: meta.inputSummary,
  });

  const result = { ...EMPTY };

  /** One LLM pass, recorded by the shared LLM tracing layer. Null on failure. */
  async function complete(
    system: string,
    userContent: string,
    callKind: "insight-hour" | "insight-rollup",
  ): Promise<{ content: string; model: string } | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    const label = callKind === "insight-hour" ? "hour insight" : "period roll-up";
    try {
      const completion = await deps.complete(messages, {
        recorder: trace,
        callKind,
        label,
      });
      return { content: completion.content, model: normalizeModelName(completion.model) };
    } catch (err) {
      await trace.event({
        type: "error",
        level: "warn",
        message: "LLM pass failed — left for the next run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  try {
    // Every period a freshly-scored hour belongs to, deduped — the roll-up set.
    const touched = new Map<string, PeriodTarget>();

    /* Pass 1 — score each pending (chat, hour). */
    let unitIdx = 0;
    for (const unit of pending) {
      deps.onProgress?.({
        step: `Scoring hour ${unit.insightHour}`,
        current: ++unitIdx,
        total: pending.length,
      });
      const [messages, topics] = await Promise.all([
        getHourMessages(content, {
          chatRef: unit.chatRef,
          insightHour: unit.insightHour,
          timeZone: deps.timeZone,
        }),
        getDaySummaryTopics(content, {
          chatRef: unit.chatRef,
          date: unit.insightHour.slice(0, 10),
        }),
      ]);
      const transcript = formatTranscript(messages);
      if (!transcript) {
        await upsertChatHourInsight(db, {
          chatRef: unit.chatRef,
          insightHour: unit.insightHour,
          moodScore: 50,
          moodLabel: moodLabelForScore(50),
          moodSummary: "No readable text this hour.",
          topTopic: "—",
          word: "—",
          messageCount: unit.messageCount,
          model: "n/a",
        });
        result.unitsComputed += 1;
        for (const t of periodsForHour(unit.insightHour, unit.chatRef)) touched.set(targetKey(t), t);
        continue;
      }

      const out = await complete(
        HOUR_INSIGHT_PROMPT,
        buildHourInsightRequest({ transcript, topics }),
        "insight-hour",
      );
      if (!out) {
        result.unitsFailed += 1;
        continue;
      }
      const parsed = parseHourInsight(out.content);
      if (!parsed) {
        result.unitsFailed += 1;
        await trace.event({
          type: "step",
          level: "warn",
          message: "unusable hour insight — left for the next run",
          data: { chatRef: unit.chatRef, hour: unit.insightHour, content: out.content },
        });
        continue;
      }

      await upsertChatHourInsight(db, {
        chatRef: unit.chatRef,
        insightHour: unit.insightHour,
        moodScore: parsed.moodScore,
        moodLabel: parsed.moodLabel,
        moodSummary: parsed.moodSummary,
        topTopic: parsed.topTopic,
        word: parsed.word,
        messageCount: unit.messageCount,
        model: out.model,
      });
      result.unitsComputed += 1;
      for (const t of periodsForHour(unit.insightHour, unit.chatRef)) touched.set(targetKey(t), t);

      await trace.event({
        type: "step",
        level: "success",
        message: `hour scored: ${unit.chatRef} ${unit.insightHour}`,
        data: { ...parsed, messageCount: unit.messageCount },
      });
    }

    /* Pass 2 — roll up every touched period, finest granularity first. */
    const targets = [...touched.values()]
      .sort(
        (a, b) =>
          GRANULARITY_ORDER.indexOf(a.granularity) - GRANULARITY_ORDER.indexOf(b.granularity),
      )
      .slice(0, MAX_PERIODS_PER_RUN);

    let periodIdx = 0;
    for (const target of targets) {
      deps.onProgress?.({
        step: `Rolling up ${target.granularity} ${target.bucket}`,
        current: ++periodIdx,
        total: targets.length,
      });
      const rolled = await rollUpPeriod(db, target, complete);
      if (rolled === "failed") result.periodsFailed += 1;
      else if (rolled === "written") result.periodsComputed += 1;
    }

    const summary =
      (meta.dropped ? `${meta.dropped.units} hour score(s) dropped, ` : "") +
      `${result.unitsComputed} hour(s) scored, ${result.periodsComputed} period(s) rolled up` +
      (result.unitsFailed + result.periodsFailed > 0
        ? `, ${result.unitsFailed + result.periodsFailed} left pending`
        : "");

    await trace.succeed({ outputSummary: summary });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
    return { ...result, summary };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

type RollupOutcome = "written" | "failed" | "empty";

/**
 * Roll one period up from its immediate children.
 *
 * The `hour` granularity is a straight copy of the scored hour row — no LLM call —
 * so that every mood read, from a day's 24 points to the all-time figure, is one
 * uniform query against `period_insights` instead of a special case for the finest
 * grain.
 */
async function rollUpPeriod(
  db: StoreDb,
  target: PeriodTarget,
  complete: (
    system: string,
    userContent: string,
    callKind: "insight-hour" | "insight-rollup",
  ) => Promise<{ content: string; model: string } | null>,
): Promise<RollupOutcome> {
  const children = await loadChildren(db, target);
  if (children.length === 0) return "empty";

  const moodScore = weightedMood(children);
  const messageCount = children.reduce((a, c) => a + c.messageCount, 0);
  const sourceUnits = children.reduce((a, c) => a + c.sourceUnits, 0);

  // The heaviest child — the deterministic answer, and the fallback whenever the
  // model's choice is unusable. It is a real observed topic either way.
  const heaviest = children.reduce((a, c) => (c.messageCount > a.messageCount ? c : a));

  let word = heaviest.word;
  let topTopic = heaviest.topTopic;
  let model = "copy";

  if (children.length > 1) {
    const label = target.granularity === "all" ? "all time" : `${target.granularity} ${target.bucket}`;
    const out = await complete(
      PERIOD_ROLLUP_PROMPT,
      buildPeriodRollupRequest({
        label,
        children: children.map(
          (c): RollupChild => ({
            bucket: c.bucket,
            moodLabel: c.moodLabel,
            topTopic: c.topTopic,
            word: c.word,
            messageCount: c.messageCount,
          }),
        ),
      }),
      "insight-rollup",
    );
    if (!out) return "failed";
    const choice = parseRollupChoice(out.content, children.length);
    // An unusable choice is not a failed period: the heaviest child is already a
    // correct "top", so the period is written rather than left permanently owed.
    if (choice) {
      topTopic = children[choice.topicIndex].topTopic;
      word = children[choice.wordIndex].word;
      model = out.model;
    }
  }

  await upsertPeriodInsight(db, {
    granularity: target.granularity,
    bucket: target.bucket,
    chatRef: target.chatRef,
    wordOfPeriod: word,
    topTopic,
    moodScore,
    moodLabel: moodLabelForScore(moodScore),
    sourceUnits,
    messageCount,
    model,
  });
  return "written";
}

/** One child row feeding a roll-up, normalized across the two source tables. */
interface RollupSource {
  bucket: string;
  moodScore: number;
  moodLabel: string;
  topTopic: string;
  word: string;
  messageCount: number;
  /** Scored hours behind this child (1 for an hour row). */
  sourceUnits: number;
}

/**
 * The rows a period rolls up from: the scored hour itself for `hour`, and the stored
 * next-finer roll-ups for everything else.
 */
async function loadChildren(db: StoreDb, target: PeriodTarget): Promise<RollupSource[]> {
  if (target.granularity === "hour") {
    const rows = await listHourInsightsForPeriod(db, {
      granularity: "hour",
      bucket: target.bucket,
      chatRef: target.chatRef,
    });
    return rows.map((r) => ({
      bucket: r.insightHour,
      moodScore: r.moodScore,
      moodLabel: r.moodLabel,
      topTopic: r.topTopic,
      word: r.word ?? r.topTopic,
      messageCount: r.messageCount,
      sourceUnits: 1,
    }));
  }

  const childGranularity = ROLLUP_CHILD[target.granularity];
  const rows = await listPeriodInsights(db, {
    granularity: childGranularity,
    buckets: childBuckets(target),
    chatRef: target.chatRef,
  });
  return rows.map((r) => ({
    bucket: r.bucket,
    moodScore: r.moodScore,
    moodLabel: r.moodLabel,
    topTopic: r.topTopic,
    word: r.wordOfPeriod,
    messageCount: r.messageCount,
    sourceUnits: r.sourceUnits,
  }));
}

/**
 * How far back `all` looks for year rows. `all` has no key prefix to match on, so
 * its children have to be enumerated; bounding by the calendar rather than by the
 * data keeps this a pure function, and absent years simply return no rows.
 */
const ALL_TIME_YEARS = 30;

/**
 * The exact child bucket keys a period covers.
 *
 * This is the same enumeration the charts use for their x-axis
 * ({@link subBucketKeys}) — a month's children and a month chart's points are the
 * same list of days, so they share one definition rather than two that could drift.
 */
function childBuckets(target: PeriodTarget): string[] {
  if (target.granularity === "hour") return [];
  if (target.granularity === "all") {
    const thisYear = new Date().getUTCFullYear();
    return Array.from({ length: ALL_TIME_YEARS }, (_, i) => String(thisYear - i));
  }
  return subBucketKeys(target.granularity, target.bucket);
}
