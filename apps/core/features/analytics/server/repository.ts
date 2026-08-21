import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatHourInsights, periodInsights } from "@/db/schema";

import { addCalendarDays, zonedWallClockToUtc } from "@/features/tasks/schedule";

import { addDaysToDateStr, bucketFormat, truncUnit } from "../period";
import type { Granularity } from "../types";

/**
 * Typed persistence + live-SQL aggregation for the analytics cards whose source is
 * the database: message volume, users, and the stored insight rows.
 *
 * Token, model-performance, and traffic metrics are **not** here — their source is
 * the trace files (`trace-source.ts`). Pure data access: no policy, no LLM, no
 * tracing (the services own those).
 */

/**
 * Time/scope filter for the message-based metric queries.
 *
 * `endUtc` is **exclusive**, and it is not optional. The previous shape had a lower
 * bound only, so "this day" and "this week" both reached forward to now and returned
 * the same totals whenever all the data was recent — the bug that made the Traffic
 * filters look broken.
 */
export interface MetricScope {
  startUtc: Date;
  endUtc: Date;
  chatId?: string | null;
  userId?: string | null;
}

/** The wall-clock bucket key expression for a timestamptz column, or `'all'`. */
function bucketExpr(column: SQL, granularity: Granularity, timeZone: string): SQL {
  const unit = truncUnit(granularity);
  if (!unit) return sql`'all'`;
  return sql`to_char(date_trunc(${unit}, (${column} at time zone ${timeZone})), ${bucketFormat(granularity)})`;
}

/** Build the shared `chat_messages` WHERE clause from a scope. */
function messageWhere(scope: MetricScope): SQL {
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`sent_at >= ${scope.startUtc}`,
    sql`sent_at < ${scope.endUtc}`,
  ];
  if (scope.chatId) parts.push(sql`chat_id = ${scope.chatId}`);
  if (scope.userId) parts.push(sql`user_id = ${scope.userId}`);
  return sql.join(parts, sql` and `);
}

export interface MessageSeriesRow {
  bucket: string;
  human: number;
  bot: number;
  activeUsers: number;
}

/** Per-bucket message volume and active users. */
export async function getMessageSeries(
  db: DrizzleDb,
  params: MetricScope & { bucketUnit: Granularity; timeZone: string },
): Promise<MessageSeriesRow[]> {
  const bucket = bucketExpr(sql`sent_at`, params.bucketUnit, params.timeZone);
  const rows = await db.execute<{ bucket: string; human: number; bot: number; active_users: number }>(sql`
    select
      ${bucket} as bucket,
      count(*) filter (where role = 'user')::int as human,
      count(*) filter (where role = 'assistant')::int as bot,
      count(distinct user_id) filter (where role = 'user')::int as active_users
    from chat_messages
    where ${messageWhere(params)}
    group by 1
  `);
  return rows.rows.map((r) => ({
    bucket: r.bucket,
    human: Number(r.human),
    bot: Number(r.bot),
    activeUsers: Number(r.active_users),
  }));
}

/** Per-bucket count of users first seen in the period (global only). */
export async function getNewUserSeries(
  db: DrizzleDb,
  params: { startUtc: Date; endUtc: Date; bucketUnit: Granularity; timeZone: string },
): Promise<Map<string, number>> {
  const bucket = bucketExpr(sql`first_seen_at`, params.bucketUnit, params.timeZone);
  const rows = await db.execute<{ bucket: string; new_users: number }>(sql`
    select ${bucket} as bucket, count(*)::int as new_users
    from known_users
    where first_seen_at >= ${params.startUtc} and first_seen_at < ${params.endUtc}
    group by 1
  `);
  return new Map(rows.rows.map((r) => [r.bucket, Number(r.new_users)]));
}

export interface TopUserRow {
  userId: string;
  messages: number;
}

/** The most active human senders in the period (optionally within one chat). */
export async function getTopUsers(
  db: DrizzleDb,
  params: { startUtc: Date; endUtc: Date; chatId?: string | null; limit: number },
): Promise<TopUserRow[]> {
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`role = 'user'`,
    sql`user_id is not null`,
    sql`sent_at >= ${params.startUtc}`,
    sql`sent_at < ${params.endUtc}`,
  ];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ user_id: string; messages: number }>(sql`
    select user_id, count(*)::int as messages
    from chat_messages
    where ${sql.join(parts, sql` and `)}
    group by user_id
    order by messages desc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({ userId: r.user_id, messages: Number(r.messages) }));
}

/** Bucket keys in a range that hold any message — the calendar's data marks. */
export async function getMessageAvailability(
  db: DrizzleDb,
  params: {
    startUtc: Date;
    endUtc: Date;
    bucketUnit: Granularity;
    timeZone: string;
    chatId?: string | null;
  },
): Promise<string[]> {
  const bucket = bucketExpr(sql`sent_at`, params.bucketUnit, params.timeZone);
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`sent_at >= ${params.startUtc}`,
    sql`sent_at < ${params.endUtc}`,
  ];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ bucket: string }>(sql`
    select distinct ${bucket} as bucket
    from chat_messages
    where ${sql.join(parts, sql` and `)}
    order by 1
  `);
  return rows.rows.map((r) => r.bucket);
}

/* ------------------------------------------------------------------------- *
 * Insight-row persistence (written by the nightly job).
 *
 * The scored unit is the **chat-hour**. Everything the dashboard shows — a day's
 * mood curve, a month's word, the all-time top topic — is a roll-up of hours, so
 * hour is the one place conversation is ever read by an LLM.
 * ------------------------------------------------------------------------- */

export interface PendingInsightHour {
  chatId: string;
  insightHour: string;
  messageCount: number;
}

/**
 * (chat, hour) pairs that have no stored insight yet. An hour is owed only when it
 * has never been scored — a *scored* hour is final, and is never silently re-read
 * because its message count drifted. Correcting an existing score is an explicit
 * operator action ({@link deleteInsightsForPeriod} + a run), so the job's token spend
 * is predictable and nothing rewrites itself behind your back. The current
 * (unfinished) hour is excluded.
 */
export async function listHoursNeedingInsight(
  db: DrizzleDb,
  params: { timeZone: string; currentHour: string; limit: number; floorHour?: string },
): Promise<PendingInsightHour[]> {
  const rows = await db.execute<{ chat_id: string; insight_hour: string; message_count: number }>(sql`
    with hours as (
      select
        chat_id,
        to_char(date_trunc('hour', (sent_at at time zone ${params.timeZone})), 'YYYY-MM-DD HH24') as insight_hour,
        count(*)::int as message_count
      from chat_messages
      where deleted_at is null ${hourScanFloorFilter(params)}
      group by 1, 2
    )
    select hours.chat_id, hours.insight_hour, hours.message_count
    from hours
    left join chat_hour_insights i
      on i.chat_id = hours.chat_id and i.insight_hour = hours.insight_hour
    where hours.insight_hour < ${params.currentHour}
      and i.id is null
    order by hours.insight_hour asc, hours.chat_id asc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({
    chatId: r.chat_id,
    insightHour: r.insight_hour,
    messageCount: Number(r.message_count),
  }));
}

/** Every distinct scored hour (`YYYY-MM-DD HH`), newest first — the regenerate picker's source. */
export async function listInsightHours(db: DrizzleDb): Promise<string[]> {
  const rows = await db.execute<{ insight_hour: string }>(sql`
    select distinct insight_hour from chat_hour_insights order by insight_hour desc
  `);
  return rows.rows.map((r) => r.insight_hour);
}

/**
 * The scan-floor bound for the due-scan CTEs: only group messages at or after
 * the floor hour (inclusive — the floor hour itself may still be owed). The
 * bound is applied to raw `sent_at`, so rows below it skip the per-row timezone
 * expression entirely instead of being grouped and then filtered out.
 */
function hourScanFloorFilter(params: { timeZone: string; floorHour?: string }): SQL {
  if (!params.floorHour) return sql``;
  const { fromUtc } = insightHourUtcRange(params.floorHour, params.timeZone);
  return sql`and sent_at >= ${fromUtc}`;
}

/** How many (chat, hour) pairs still need an insight — for the dashboard backlog. */
export async function countHoursNeedingInsight(
  db: DrizzleDb,
  params: { timeZone: string; currentHour: string; floorHour?: string },
): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with hours as (
      select
        chat_id,
        to_char(date_trunc('hour', (sent_at at time zone ${params.timeZone})), 'YYYY-MM-DD HH24') as insight_hour
      from chat_messages
      where deleted_at is null ${hourScanFloorFilter(params)}
      group by 1, 2
    )
    select count(*)::int as n
    from hours
    left join chat_hour_insights i
      on i.chat_id = hours.chat_id and i.insight_hour = hours.insight_hour
    where hours.insight_hour < ${params.currentHour} and i.id is null
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

/** The `chat_hour_insights.insight_hour` filter for a period bucket. */
function hourDateFilter(granularity: Granularity, bucket: string): SQL | null {
  // `insight_hour` is `YYYY-MM-DD HH`, so its first 10 chars are the date.
  const date = sql`left(insight_hour, 10)`;
  switch (granularity) {
    case "hour":
      return sql`insight_hour = ${bucket}`;
    case "day":
      return sql`${date} = ${bucket}`;
    case "week":
      return sql`${date} >= ${bucket} and ${date} <= ${addDaysToDateStr(bucket, 6)}`;
    case "month":
    case "year":
      return sql`insight_hour like ${`${bucket}-%`}`;
    case "all":
      return null;
  }
}

/**
 * Drop every stored insight covering a period — the hour scores *and* the roll-ups
 * built from them — so the next run recomputes them from the messages.
 *
 * Deleting the hour rows is what re-arms the work: an hour with no row is owed (see
 * {@link listHoursNeedingInsight}), so a regenerate that dies half-way is picked up
 * by the next nightly run rather than leaving a permanent hole. The roll-ups go too
 * because a roll-up whose hour rows have been dropped is a stale claim about hours
 * that no longer exist.
 *
 * **Scoped to the chats that actually lost an hour.** A roll-up is only invalidated
 * by its own chat's hours changing, and only that chat's hours get re-armed — so
 * deleting across every chat destroyed insights for conversations that had no
 * activity in the period at all, with nothing left to rebuild them. Found live:
 * regenerating one day silently erased two other chats' month/year/all-time rows,
 * recoverable only by re-scoring the entire history.
 */
export async function deleteInsightsForPeriod(
  db: DrizzleDb,
  params: { granularity: Granularity; bucket: string },
): Promise<{ units: number; periods: number }> {
  const dateFilter = hourDateFilter(params.granularity, params.bucket);
  const hourWhere = dateFilter ? sql`where ${dateFilter}` : sql``;
  // `returning chat_id` is what makes the scoping possible: the set of affected
  // chats is exactly the set whose hours we just dropped.
  const deletedHours = await db.execute<{ chat_id: string }>(sql`
    delete from chat_hour_insights ${hourWhere} returning chat_id
  `);
  const units = deletedHours.rows.length;
  const chatIds = [...new Set(deletedHours.rows.map((r) => r.chat_id))];

  if (chatIds.length === 0) return { units, periods: 0 };

  const chatFilter = sql`chat_id in (${sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  // An hour's score feeds every period containing it, so dropping a range of hours
  // invalidates that chat's roll-ups at *every* granularity that overlaps the range
  // — not just the one asked for. `all` overlaps everything.
  const rangeFilter =
    params.granularity === "all"
      ? sql`true`
      : sql`(granularity = 'all' or ${periodOverlapFilter(params.granularity, params.bucket)})`;
  const periods = await db.execute<{ n: number }>(sql`
    with deleted as (
      delete from period_insights where ${chatFilter} and ${rangeFilter} returning 1
    )
    select count(*)::int as n from deleted
  `);

  return { units, periods: Number(periods.rows[0]?.n ?? 0) };
}

/**
 * Matches every stored period row whose date range overlaps the given bucket, by
 * comparing each row's own first/last day. A week can straddle two months and a
 * month sits inside a year, so a containment test on the bucket string alone would
 * miss rows that genuinely covered a dropped hour.
 */
function periodOverlapFilter(granularity: Granularity, bucket: string): SQL {
  const [start, end] = periodDayRange(granularity, bucket);
  // Each row's span, derived from its granularity + bucket key.
  const rowStart = sql`case granularity
    when 'hour' then left(bucket, 10)
    when 'day' then bucket
    when 'week' then bucket
    when 'month' then bucket || '-01'
    when 'year' then bucket || '-01-01'
  end`;
  const rowEnd = sql`case granularity
    when 'hour' then left(bucket, 10)
    when 'day' then bucket
    when 'week' then to_char(to_date(bucket, 'YYYY-MM-DD') + 6, 'YYYY-MM-DD')
    when 'month' then to_char((to_date(bucket || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD')
    when 'year' then bucket || '-12-31'
  end`;
  return sql`(granularity <> 'all' and ${rowStart} <= ${end} and ${rowEnd} >= ${start})`;
}

/** The inclusive first/last `YYYY-MM-DD` a period bucket covers. */
function periodDayRange(granularity: Granularity, bucket: string): [string, string] {
  switch (granularity) {
    case "hour":
      return [bucket.slice(0, 10), bucket.slice(0, 10)];
    case "day":
      return [bucket, bucket];
    case "week":
      return [bucket, addDaysToDateStr(bucket, 6)];
    case "month":
      return [`${bucket}-01`, `${bucket}-31`];
    case "year":
      return [`${bucket}-01-01`, `${bucket}-12-31`];
    case "all":
      return ["0000-01-01", "9999-12-31"];
  }
}

/** The half-open UTC instant range one `YYYY-MM-DD HH` wall-clock hour covers. */
function insightHourUtcRange(
  insightHour: string,
  timeZone: string,
): { fromUtc: Date; toUtc: Date } {
  const [date, hourStr] = insightHour.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(hourStr);
  const next =
    hour === 23
      ? { ...addCalendarDays(year, month, day, 1), hour: 0 }
      : { year, month, day, hour: hour + 1 };
  return {
    fromUtc: zonedWallClockToUtc(year, month, day, hour, 0, timeZone),
    toUtc: zonedWallClockToUtc(next.year, next.month, next.day, next.hour, 0, timeZone),
  };
}

/**
 * An hour's messages (role + text), oldest first — the LLM insight input.
 *
 * The hour is turned into UTC instant bounds in code rather than filtering on a
 * `to_char(… at time zone …)` expression: the range predicate uses the
 * `(chat_id, sent_at)` index, where the computed expression re-derived the local
 * hour for every row of the chat.
 */
export async function getHourMessages(
  db: DrizzleDb,
  params: { chatId: string; insightHour: string; timeZone: string },
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { fromUtc, toUtc } = insightHourUtcRange(params.insightHour, params.timeZone);
  const rows = await db.execute<{ role: string; content: string }>(sql`
    select role, content
    from chat_messages
    where chat_id = ${params.chatId}
      and deleted_at is null
      and sent_at >= ${fromUtc}
      and sent_at < ${toUtc}
    order by sent_at asc, id asc
  `);
  return rows.rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
  }));
}

/** A day's already-distilled topic summaries for a chat (extra insight context). */
export async function getDaySummaryTopics(
  db: DrizzleDb,
  params: { chatId: string; date: string },
): Promise<string[]> {
  const rows = await db.execute<{ content: string }>(sql`
    select content from chat_summaries
    where chat_id = ${params.chatId} and summary_date = ${params.date}
    order by id asc
  `);
  return rows.rows.map((r) => r.content);
}

export interface UpsertHourInsight {
  chatId: string;
  insightHour: string;
  moodScore: number;
  moodLabel: string;
  moodSummary: string;
  topTopic: string;
  word: string;
  messageCount: number;
  model: string;
}

/** Insert or refresh one (chat, hour) scored insight. */
export async function upsertChatHourInsight(db: DrizzleDb, row: UpsertHourInsight): Promise<void> {
  await db
    .insert(chatHourInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [chatHourInsights.chatId, chatHourInsights.insightHour],
      set: {
        moodScore: row.moodScore,
        moodLabel: row.moodLabel,
        moodSummary: row.moodSummary,
        topTopic: row.topTopic,
        word: row.word,
        messageCount: row.messageCount,
        model: row.model,
        updatedAt: new Date(),
      },
    });
}

export interface PeriodUnitRow {
  chatId: string;
  insightHour: string;
  moodScore: number;
  moodLabel: string;
  topTopic: string;
  word: string | null;
  messageCount: number;
}

/** Scored hour rows falling within a period bucket, for one chat. */
export async function listHourInsightsForPeriod(
  db: DrizzleDb,
  params: { granularity: Granularity; bucket: string; chatId: string },
): Promise<PeriodUnitRow[]> {
  const parts: SQL[] = [sql`chat_id = ${params.chatId}`];
  const dateFilter = hourDateFilter(params.granularity, params.bucket);
  if (dateFilter) parts.push(dateFilter);
  const rows = await db.execute<{
    chat_id: string;
    insight_hour: string;
    mood_score: number;
    mood_label: string;
    top_topic: string;
    word: string | null;
    message_count: number;
  }>(sql`
    select chat_id, insight_hour, mood_score, mood_label, top_topic, word, message_count
    from chat_hour_insights
    where ${sql.join(parts, sql` and `)}
    order by insight_hour asc
  `);
  return rows.rows.map((r) => ({
    chatId: r.chat_id,
    insightHour: r.insight_hour,
    moodScore: Number(r.mood_score),
    moodLabel: r.mood_label,
    topTopic: r.top_topic,
    word: r.word,
    messageCount: Number(r.message_count),
  }));
}

export interface UpsertPeriodInsight {
  granularity: Granularity;
  bucket: string;
  chatId: string;
  wordOfPeriod: string;
  topTopic: string;
  moodScore: number;
  moodLabel: string;
  sourceUnits: number;
  messageCount: number;
  model: string;
}

/** Insert or refresh one period insight (hour/day/week/month/year/all × chat). */
export async function upsertPeriodInsight(db: DrizzleDb, row: UpsertPeriodInsight): Promise<void> {
  await db
    .insert(periodInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [periodInsights.granularity, periodInsights.bucket, periodInsights.chatId],
      set: {
        wordOfPeriod: row.wordOfPeriod,
        topTopic: row.topTopic,
        moodScore: row.moodScore,
        moodLabel: row.moodLabel,
        sourceUnits: row.sourceUnits,
        messageCount: row.messageCount,
        model: row.model,
        computedAt: new Date(),
      },
    });
}

export type StoredPeriodInsight = UpsertPeriodInsight & { computedAt: string };

interface PeriodRowShape extends Record<string, unknown> {
  granularity: string;
  bucket: string;
  chat_id: string;
  word_of_period: string;
  top_topic: string;
  mood_score: number;
  mood_label: string;
  source_units: number;
  message_count: number;
  model: string;
  computed_at: string | Date;
}

function mapPeriodRow(r: PeriodRowShape): StoredPeriodInsight {
  return {
    granularity: r.granularity as Granularity,
    bucket: r.bucket,
    chatId: r.chat_id,
    wordOfPeriod: r.word_of_period,
    topTopic: r.top_topic,
    moodScore: Number(r.mood_score),
    moodLabel: r.mood_label,
    sourceUnits: Number(r.source_units),
    messageCount: Number(r.message_count),
    model: r.model,
    computedAt: new Date(r.computed_at).toISOString(),
  };
}

/** The stored insight for an exact period in one chat, or null. */
export async function getPeriodInsight(
  db: DrizzleDb,
  params: { granularity: Granularity; bucket: string; chatId: string },
): Promise<StoredPeriodInsight | null> {
  const rows = await db.execute<PeriodRowShape>(sql`
    select * from period_insights
    where granularity = ${params.granularity} and bucket = ${params.bucket}
      and chat_id = ${params.chatId}
    limit 1
  `);
  const r = rows.rows[0];
  return r ? mapPeriodRow(r) : null;
}

/**
 * Stored insights for an explicit list of buckets at one granularity, for one chat.
 *
 * This is what the mood trend reads: the caller already knows the dense sub-bucket
 * axis it wants (from {@link import("../period").subBucketKeys}), so it asks for
 * exactly those and treats a missing row as a gap rather than a zero.
 */
export async function listPeriodInsights(
  db: DrizzleDb,
  params: { granularity: Granularity; buckets: string[]; chatId: string },
): Promise<StoredPeriodInsight[]> {
  if (params.buckets.length === 0) return [];
  const rows = await db.execute<PeriodRowShape>(sql`
    select * from period_insights
    where granularity = ${params.granularity}
      and chat_id = ${params.chatId}
      and bucket in (${sql.join(
        params.buckets.map((b) => sql`${b}`),
        sql`, `,
      )})
    order by bucket asc
  `);
  return rows.rows.map(mapPeriodRow);
}

/** Distinct buckets at a granularity that hold a stored insight, for one chat. */
export async function getInsightAvailability(
  db: DrizzleDb,
  params: { granularity: Granularity; chatId: string },
): Promise<string[]> {
  const rows = await db.execute<{ bucket: string }>(sql`
    select distinct bucket from period_insights
    where granularity = ${params.granularity} and chat_id = ${params.chatId}
    order by 1
  `);
  return rows.rows.map((r) => r.bucket);
}
