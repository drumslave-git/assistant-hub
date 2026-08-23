import { sql, type SQL } from "drizzle-orm";

import type { TgDb } from "../db";

/**
 * Message-volume aggregation for the core's analytics feature, ported from
 * the v1 analytics repository (the swap): the mirror lives here, so the
 * group-bys run next to the data and only bucketed numbers cross the API.
 *
 * Bucket keys are wall-clock strings in the caller's timezone, formatted to
 * match the core period module's `bucketKey` exactly (`YYYY-MM-DD HH24` /
 * `YYYY-MM-DD` / `YYYY-MM` / `YYYY`, `all` for the single-bucket case; a
 * week's key is its Monday's date — the `date_trunc` unit carries the
 * difference).
 */

export type BucketUnit = "hour" | "day" | "week" | "month" | "year" | "all";

/** The `to_char` format matching the core's bucket keys (see module doc). */
function bucketFormat(unit: BucketUnit): string {
  switch (unit) {
    case "hour":
      return "YYYY-MM-DD HH24";
    case "day":
    case "week":
      return "YYYY-MM-DD";
    case "month":
      return "YYYY-MM";
    case "year":
      return "YYYY";
    case "all":
      return "all";
  }
}

/** The wall-clock bucket key expression for a timestamptz column, or `'all'`. */
function bucketExpr(column: SQL, unit: BucketUnit, timeZone: string): SQL {
  if (unit === "all") return sql`'all'`;
  return sql`to_char(date_trunc(${unit}, (${column} at time zone ${timeZone})), ${bucketFormat(unit)})`;
}

/** Time/scope filter shared by the message aggregates (`to` exclusive). */
export interface MessageScope {
  fromUtc: Date;
  toUtc: Date;
  chatId?: string | null;
  userId?: string | null;
}

/** The shared visible-messages WHERE clause for a scope. */
function messageWhere(scope: MessageScope): SQL {
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`sent_at >= ${scope.fromUtc}`,
    sql`sent_at < ${scope.toUtc}`,
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
  db: TgDb,
  params: MessageScope & { unit: BucketUnit; timeZone: string },
): Promise<MessageSeriesRow[]> {
  const bucket = bucketExpr(sql`sent_at`, params.unit, params.timeZone);
  const rows = await db.execute<{
    bucket: string;
    human: number;
    bot: number;
    active_users: number;
  }>(sql`
    select
      ${bucket} as bucket,
      count(*) filter (where role = 'user')::int as human,
      count(*) filter (where role = 'assistant')::int as bot,
      count(distinct user_id) filter (where role = 'user')::int as active_users
    from messages
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
  db: TgDb,
  params: { fromUtc: Date; toUtc: Date; unit: BucketUnit; timeZone: string },
): Promise<{ bucket: string; newUsers: number }[]> {
  const bucket = bucketExpr(sql`first_seen_at`, params.unit, params.timeZone);
  const rows = await db.execute<{ bucket: string; new_users: number }>(sql`
    select ${bucket} as bucket, count(*)::int as new_users
    from users
    where first_seen_at >= ${params.fromUtc} and first_seen_at < ${params.toUtc}
    group by 1
  `);
  return rows.rows.map((r) => ({ bucket: r.bucket, newUsers: Number(r.new_users) }));
}

/** The most active human senders in the period (optionally within one chat). */
export async function getTopUsers(
  db: TgDb,
  params: { fromUtc: Date; toUtc: Date; chatId?: string | null; limit: number },
): Promise<{ userId: string; messages: number }[]> {
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`role = 'user'`,
    sql`user_id is not null`,
    sql`sent_at >= ${params.fromUtc}`,
    sql`sent_at < ${params.toUtc}`,
  ];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ user_id: string; messages: number }>(sql`
    select user_id, count(*)::int as messages
    from messages
    where ${sql.join(parts, sql` and `)}
    group by user_id
    order by messages desc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({ userId: r.user_id, messages: Number(r.messages) }));
}

/** Bucket keys in a range that hold any message — the calendar's data marks. */
export async function getMessageAvailability(
  db: TgDb,
  params: {
    fromUtc: Date;
    toUtc: Date;
    unit: BucketUnit;
    timeZone: string;
    chatId?: string | null;
  },
): Promise<string[]> {
  const bucket = bucketExpr(sql`sent_at`, params.unit, params.timeZone);
  const parts: SQL[] = [
    sql`deleted_at is null`,
    sql`sent_at >= ${params.fromUtc}`,
    sql`sent_at < ${params.toUtc}`,
  ];
  if (params.chatId) parts.push(sql`chat_id = ${params.chatId}`);
  const rows = await db.execute<{ bucket: string }>(sql`
    select distinct ${bucket} as bucket
    from messages
    where ${sql.join(parts, sql` and `)}
    order by 1
  `);
  return rows.rows.map((r) => r.bucket);
}

export interface ChatHourCount {
  chatId: string;
  /** `YYYY-MM-DD HH24` in the requested timezone. */
  insightHour: string;
  messageCount: number;
}

/**
 * Every (chat, wall-clock hour) pair holding visible messages, with counts —
 * the source half of the core's insight due-scan (the split-scan shape of
 * {@link import("./summaries").listChatDayCounts}). `fromUtc` is the core's
 * scan floor applied to raw `sent_at`, so rows below it skip the per-row
 * timezone expression entirely.
 */
export async function listChatHourCounts(
  db: TgDb,
  params: { timeZone: string; fromUtc?: Date },
): Promise<ChatHourCount[]> {
  const floor = params.fromUtc ? sql`and sent_at >= ${params.fromUtc}` : sql``;
  const rows = await db.execute<{
    chat_id: string;
    insight_hour: string;
    message_count: number;
  }>(sql`
    select
      chat_id,
      to_char(date_trunc('hour', (sent_at at time zone ${params.timeZone})), 'YYYY-MM-DD HH24') as insight_hour,
      count(*)::int as message_count
    from messages
    where deleted_at is null ${floor}
    group by 1, 2
    order by 2 asc, 1 asc
  `);
  return rows.rows.map((r) => ({
    chatId: r.chat_id,
    insightHour: r.insight_hour,
    messageCount: Number(r.message_count),
  }));
}
