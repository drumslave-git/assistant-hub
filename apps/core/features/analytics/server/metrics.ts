import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getTimezone } from "@/features/settings/server/service";

import { moodLabelForScore } from "../mood";
import { currentAnchor, densify, periodRange, subBucketKeys, subUnitOf } from "../period";
import type {
  MetricContext,
  ModelsPayload,
  MoodPayload,
  NamedSeries,
  PeriodInsight,
  PeriodUnit,
  SeriesPayload,
  SeriesSection,
  TopUsersPayload,
  TotalsPayload,
} from "../types";
import type { AvailabilityQuery, InsightsQuery, MetricsQuery, SeriesQuery } from "./schema";
import {
  getInsightAvailability,
  getMessageAvailability,
  getMessageSeries,
  getNewUserSeries,
  getPeriodInsight,
  getTopUsers,
  listPeriodInsights,
  type MetricScope,
} from "./repository";
import {
  buildModelStats,
  bucketTokens,
  scanScopeTraces,
  tokensByActor,
  totalTokens,
  traceAvailabilityFrom,
  trafficTotalsFrom,
  usageRowsFrom,
} from "./trace-source";

/**
 * The analytics read service — the boundary the Route Handlers and the dashboard
 * Server Component call.
 *
 * Reads are **per card**, not one payload for the page: each card carries its own
 * period and chat/user filter, so a single combined query would have to be re-run in
 * full for every card that moved.
 *
 * Every card resolves its filters through {@link resolvePeriod}, which turns
 * `(unit, anchor)` into one half-open instant range. That single funnel is what makes
 * "Day" mean *that day* everywhere — the previous per-card trailing windows silently
 * disagreed with each other and with the label on the control.
 */

const TOP_USERS = 10;

/** The context every card's payload echoes back, plus the resolved instant range. */
async function resolvePeriod(
  query: MetricsQuery,
  db: DrizzleDb,
): Promise<{ ctx: MetricContext; range: { startUtc: Date; endUtc: Date }; scope: MetricScope }> {
  const timezone = await getTimezone(db);
  const chatId = query.chatId ?? null;
  const userId = query.userId ?? null;
  // The anchor is resolved against the **operator** timezone, never the browser's:
  // "today" on a dashboard means today where the bot lives.
  const anchor = query.anchor ?? currentAnchor(query.unit, new Date(), timezone);
  const range = periodRange(query.unit, anchor, timezone);
  return {
    ctx: {
      unit: query.unit,
      anchor,
      timezone,
      scope: userId ? "user" : chatId ? "chat" : "global",
      chatId,
      userId,
    },
    range,
    scope: { ...range, chatId, userId },
  };
}

/** The traffic tiles for one card's filters — the bot's workload, read from traces. */
export async function getMetricTotals(
  query: MetricsQuery,
  db: DrizzleDb = getDb(),
): Promise<TotalsPayload> {
  const { ctx, scope } = await resolvePeriod(query, db);
  // One store scan feeds both readings — they used to scan independently.
  const traces = await scanScopeTraces(scope);
  const traffic = trafficTotalsFrom(traces, scope);
  const tokens = totalTokens(usageRowsFrom(traces, scope));

  return {
    ...ctx,
    totals: {
      handled: traffic.handled,
      replied: traffic.replied,
      failed: traffic.failed,
      tokensProcessed: tokens.processed,
      tokensGenerated: tokens.generated,
      activeUsers: traffic.activeUsers,
      images: traffic.images,
    },
  };
}

/** Build one chart card's series over the period's dense sub-bucket axis. */
async function seriesFor(
  section: SeriesSection,
  db: DrizzleDb,
  ctx: MetricContext,
  scope: MetricScope,
  keys: string[],
): Promise<{ series: NamedSeries[]; yMax?: number }> {
  const bucketUnit = subUnitOf(ctx.unit);
  const timeZone = ctx.timezone;

  switch (section) {
    case "volume": {
      const rows = await getMessageSeries(db, { ...scope, bucketUnit, timeZone });
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      return {
        series: [
          { name: "From users", data: keys.map((k) => byBucket.get(k)?.human ?? 0) },
          { name: "Bot replies", data: keys.map((k) => byBucket.get(k)?.bot ?? 0) },
        ],
      };
    }
    case "tokens": {
      const rows = usageRowsFrom(await scanScopeTraces(scope), scope);
      const byBucket = bucketTokens(rows, bucketUnit, timeZone);
      return {
        series: [
          { name: "Processed", data: keys.map((k) => byBucket.get(k)?.processed ?? 0) },
          { name: "Generated", data: keys.map((k) => byBucket.get(k)?.generated ?? 0) },
        ],
      };
    }
    case "users": {
      // The Users chart takes no chat/user filter: "new users" is a global fact about
      // a person's first sighting, and per-chat activity is what Message volume
      // already reports. So both lines are unconditionally global here.
      const [rows, newUsers] = await Promise.all([
        getMessageSeries(db, { startUtc: scope.startUtc, endUtc: scope.endUtc, bucketUnit, timeZone }),
        getNewUserSeries(db, {
          startUtc: scope.startUtc,
          endUtc: scope.endUtc,
          bucketUnit,
          timeZone,
        }),
      ]);
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      return {
        series: [
          { name: "Active users", data: keys.map((k) => byBucket.get(k)?.activeUsers ?? 0) },
          { name: "New users", data: densify(keys, newUsers) },
        ],
      };
    }
    case "mood": {
      // Read through the same function the Mood tile uses, so the line and the
      // number can never describe the period differently.
      const mood = await getMoodForPeriod(
        { unit: ctx.unit, anchor: ctx.anchor, chatId: ctx.chatId ?? "" },
        db,
      );
      const byBucket = new Map(mood.points.map((p) => [p.bucket, p.moodScore]));
      return {
        // A bucket with no scored row is a gap, not a zero: an unscored hour has no
        // mood, it does not have a mood of 0.
        series: [{ name: "Mood", data: keys.map((k) => byBucket.get(k) ?? null) }],
        yMax: 100,
      };
    }
  }
}

/** One chart card's payload. */
export async function getSeries(
  query: SeriesQuery,
  db: DrizzleDb = getDb(),
): Promise<SeriesPayload> {
  const { ctx, scope } = await resolvePeriod(query, db);
  const buckets = subBucketKeys(ctx.unit, ctx.anchor);
  const { series, yMax } = await seriesFor(query.section, db, ctx, scope, buckets);
  return { ...ctx, section: query.section, bucketUnit: subUnitOf(ctx.unit), buckets, series, yMax };
}

/** Model performance for one period, from the trace files. */
export async function getModels(
  query: MetricsQuery,
  db: DrizzleDb = getDb(),
): Promise<ModelsPayload> {
  const { ctx, scope } = await resolvePeriod(query, db);
  const rows = usageRowsFrom(await scanScopeTraces(scope), scope);
  return { ...ctx, models: buildModelStats(rows) };
}

/** The most active people in the period, with the tokens their turns cost. */
export async function getTopUsersCard(
  query: MetricsQuery,
  db: DrizzleDb = getDb(),
): Promise<TopUsersPayload> {
  const { ctx, scope } = await resolvePeriod(query, db);
  const rows = await getTopUsers(db, {
    startUtc: scope.startUtc,
    endUtc: scope.endUtc,
    chatId: ctx.chatId,
    limit: TOP_USERS,
  });
  const userIds = rows.map((r) => r.userId);
  const [labelRows, traces] = await Promise.all([
    userIds.length > 0 ? getKnownUsersByIds(db, userIds) : Promise.resolve([]),
    scanScopeTraces(scope),
  ]);
  const usage = usageRowsFrom(traces, scope);
  const labelById = new Map(labelRows.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const tokens = tokensByActor(usage);

  return {
    ...ctx,
    users: rows.map((r) => ({
      userId: r.userId,
      label: labelById.get(r.userId) ?? `User ${r.userId}`,
      messages: r.messages,
      tokens: tokens.get(r.userId) ?? 0,
    })),
  };
}

/**
 * The mood of one period **and** the sub-bucket points it is made of.
 *
 * One function, one query pair, both consumers: the Mood card renders `aggregate`
 * and the Mood trend chart plots `points`. They agree by construction rather than by
 * coincidence — the stored aggregate is the message-weighted mean of the same hour
 * scores the points roll up from, so the number on the tile is exactly the average
 * of the line beside it.
 */
export async function getMoodForPeriod(
  params: { unit: PeriodUnit; anchor: string; chatId: string },
  db: DrizzleDb = getDb(),
): Promise<MoodPayload> {
  if (!params.chatId) return { aggregate: null, points: [] };

  const buckets = subBucketKeys(params.unit, params.anchor);
  const [row, points] = await Promise.all([
    getPeriodInsight(db, {
      granularity: params.unit,
      bucket: params.anchor,
      chatId: params.chatId,
    }),
    buckets.length > 0
      ? listPeriodInsights(db, {
          granularity: subUnitOf(params.unit),
          buckets,
          chatId: params.chatId,
        })
      : Promise.resolve([]),
  ]);

  return {
    aggregate: row
      ? {
          moodScore: row.moodScore,
          moodLabel: row.moodLabel || moodLabelForScore(row.moodScore),
          sourceUnits: row.sourceUnits,
          messageCount: row.messageCount,
        }
      : null,
    points: points.map((p) => ({
      bucket: p.bucket,
      moodScore: p.moodScore,
      moodLabel: p.moodLabel || moodLabelForScore(p.moodScore),
    })),
  };
}

/**
 * The stored insight (word of the period + top topic + mood) for one chat's period.
 * Null before the job has rolled that period up — insights cover finished hours.
 */
export async function getPeriodInsightCard(
  query: InsightsQuery,
  db: DrizzleDb = getDb(),
): Promise<PeriodInsight | null> {
  const timezone = await getTimezone(db);
  const anchor = query.anchor ?? currentAnchor(query.unit, new Date(), timezone);
  const row = await getPeriodInsight(db, {
    granularity: query.unit,
    bucket: anchor,
    chatId: query.chatId,
  });
  if (!row) return null;

  return {
    unit: query.unit,
    anchor,
    chatId: row.chatId,
    wordOfPeriod: row.wordOfPeriod,
    topTopic: row.topTopic,
    mood: {
      moodScore: row.moodScore,
      moodLabel: row.moodLabel || moodLabelForScore(row.moodScore),
      sourceUnits: row.sourceUnits,
      messageCount: row.messageCount,
    },
    sourceUnits: row.sourceUnits,
    messageCount: row.messageCount,
    model: row.model,
    computedAt: row.computedAt,
  };
}

/**
 * Which periods in a range hold data, for the period picker's calendar.
 *
 * Answered from the card's **own** source, so a calendar never promises data the
 * card cannot show: the Tokens calendar marks periods with LLM activity, the Message
 * volume calendar marks periods with messages, and the Mood calendar marks periods
 * that have actually been scored.
 */
export async function getAvailability(
  query: AvailabilityQuery,
  db: DrizzleDb = getDb(),
): Promise<string[]> {
  const timezone = await getTimezone(db);
  const startUtc = periodRange(query.unit, query.from, timezone).startUtc;
  const endUtc = periodRange(query.unit, query.to, timezone).endUtc;

  switch (query.source) {
    case "messages":
      return getMessageAvailability(db, {
        startUtc,
        endUtc,
        bucketUnit: query.unit,
        timeZone: timezone,
        chatId: query.chatId ?? null,
      });
    case "traces":
      return traceAvailabilityFrom(await scanScopeTraces({ startUtc, endUtc }), {
        bucketUnit: query.unit,
        timeZone: timezone,
      });
    case "insights":
      return query.chatId
        ? getInsightAvailability(db, { granularity: query.unit, chatId: query.chatId })
        : [];
  }
}
