import "server-only";

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { SourceId } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import { sourceMessageSearch, sourceSummaries, type SourceSummaryRow } from "../../store/schema";

/**
 * The content plane over the conversation store — hybrid search, the message
 * search index, daily topic summaries, and message-volume analytics. The
 * former tg-app `content/*` modules, source-parameterized: the SQL runs
 * beside the data and its indexes; callers supply query text and embedding
 * vectors — models never run here.
 *
 * A read that names one chat takes its {@link SourceChatKey}; a read across
 * chats takes the list of sources it may see (the registered transports —
 * the caller's roster, never a literal here) and tags every row with the
 * source it came from.
 */

/** One chat, named by its owning source and its source-local id. */
export interface SourceChatKey {
  source: SourceId;
  chatId: string;
}

/** One person, named by their owning source and their source-local id. */
export interface SourceUserKey {
  source: SourceId;
  userId: string;
}

/** `<column> in (…)` over the sources a read may see; nothing registered reads nothing. */
function sourceIn(column: SQL, sources: readonly SourceId[]): SQL {
  if (sources.length === 0) return sql`false`;
  return sql`${column} in (${sql.join(
    sources.map((source) => sql`${source}`),
    sql`, `,
  )})`;
}

/** Filters a message search may narrow by, beyond the query itself. */
export interface SourceMessageSearchFilters {
  /** Only messages from these senders (source-local user ids). */
  authorUserIds?: string[];
  /** Only messages carrying media of these kinds. Absent → any message. */
  mediaKinds?: string[];
}

/** A search hit: the message row, the text that matched, and its fused score. */
export interface SourceMessageSearchMatch {
  id: number;
  source: SourceId;
  chatId: string;
  sourceMessageId: string;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToSourceMessageId: string | null;
  sentAt: string;
  editedAt: string | null;
  botReaction: string | null;
  createdAt: string;
  /** The indexed text (message text + media annotation), when indexed. */
  indexedContent: string | null;
  /** The message's media kind, or null for a plain text message. */
  mediaKind: string | null;
  score: number;
}

/** Reciprocal-rank-fusion damping constant — the standard k=60 from the RRF paper. */
const RRF_K = 60;

/**
 * Row shape shared by the three search pools. Snake-case because these run
 * as raw SQL (`db.execute`), which hands back the database's own column
 * names rather than the Drizzle camel-case mapping.
 */
interface PoolRow extends Record<string, unknown> {
  id: string | number;
  source: string;
  chat_id: string;
  source_message_id: string;
  role: string;
  user_id: string | null;
  content: string;
  reply_to_source_message_id: string | null;
  sent_at: Date | string;
  edited_at: Date | string | null;
  bot_reaction: string | null;
  created_at: Date | string;
  indexed_content: string | null;
  media_kind: string | null;
}

/**
 * Timestamps from a raw `db.execute` come back as strings, not `Date` — the
 * driver's type parsing is not applied to an untyped statement.
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPoolRow(row: PoolRow): Omit<SourceMessageSearchMatch, "score"> {
  return {
    id: Number(row.id),
    source: row.source,
    chatId: row.chat_id,
    sourceMessageId: row.source_message_id,
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.user_id,
    content: row.content,
    replyToSourceMessageId: row.reply_to_source_message_id,
    sentAt: toIso(row.sent_at),
    editedAt: row.edited_at ? toIso(row.edited_at) : null,
    botReaction: row.bot_reaction ?? null,
    createdAt: toIso(row.created_at),
    indexedContent: row.indexed_content,
    mediaKind: row.media_kind ?? null,
  };
}

/**
 * Hybrid search over messages: semantic (cosine distance over the indexed
 * embedding), lexical (Postgres full text over the indexed text), and
 * literal (case-insensitive substring), fused by reciprocal rank. Three
 * pools because they cover different failures — see the v1 module notes.
 * `chat: null` searches every chat of every listed source (operator search);
 * the assistant's own tool always passes its bound chat.
 */
export async function searchSourceMessagesHybrid(
  params: {
    sources: readonly SourceId[];
    chat: SourceChatKey | null;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
    filters?: SourceMessageSearchFilters;
  },
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageSearchMatch[]> {
  const text = params.queryText.trim();

  // Pull a deeper pool from each half than we return: a result ranked #10 by
  // one half and #12 by another should be able to win overall.
  const poolSize = Math.max(params.limit * 4, 20);

  const authorIds = params.filters?.authorUserIds ?? [];
  const kinds = params.filters?.mediaKinds ?? [];
  // An array in a `sql` template expands to a comma-separated *parameter
  // list*, not one array-typed parameter — so `in (…)` works.
  const authorFilter = authorIds.length > 0 ? sql`and cm.user_id in (${authorIds})` : sql``;
  const kindFilter = kinds.length > 0 ? sql`and mm.kind in (${kinds})` : sql``;
  const scopeFilter = params.chat
    ? sql`cm.source = ${params.chat.source} and cm.chat_id = ${params.chat.chatId}`
    : sourceIn(sql`cm.source`, params.sources);

  /** The visible messages in scope, joined to what a hit needs to explain itself. */
  const sourceRelation = sql`
    from source_messages cm
    left join source_message_search s
      on s.source = cm.source and s.chat_id = cm.chat_id and s.source_message_id = cm.source_message_id
    left join source_media mm
      on mm.source = cm.source and mm.chat_id = cm.chat_id and mm.source_message_id = cm.source_message_id
    where ${scopeFilter}
      and cm.deleted_at is null
      ${authorFilter}
      ${kindFilter}
  `;
  const columns = sql`
    cm.id, cm.source, cm.chat_id, cm.source_message_id, cm.role, cm.user_id, cm.content,
    cm.reply_to_source_message_id, cm.sent_at, cm.edited_at, cm.bot_reaction, cm.created_at,
    s.content as indexed_content, mm.kind as media_kind
  `;

  // Filters with no query at all — "the photos she sent". A legitimate
  // lookup with nothing to rank by, so it answers with the most recent
  // matches instead of nothing (v1 production lesson, 2026-08-07).
  if (!text && !params.queryVector) {
    if (authorIds.length === 0 && kinds.length === 0) return [];
    const rows = await db.execute<PoolRow>(sql`
      select ${columns} ${sourceRelation}
      order by cm.id desc
      limit ${params.limit}
    `);
    // Newest first while selecting, message order when returned — same
    // contract as a ranked search, so callers render one way.
    return rows.rows
      .map((row) => ({ ...mapPoolRow(row), score: 0 }))
      .sort((a, b) => a.id - b.id);
  }

  const vectorPool: PoolRow[] = params.queryVector
    ? (
        await db.execute<PoolRow>(sql`
          select ${columns} ${sourceRelation}
            and s.embedding is not null
          order by s.embedding <=> ${JSON.stringify(params.queryVector)}::vector
          limit ${poolSize}
        `)
      ).rows
    : [];

  const textPool: PoolRow[] = text
    ? (
        await db.execute<PoolRow>(sql`
          select ${columns} ${sourceRelation}
            and to_tsvector('simple', s.content) @@ websearch_to_tsquery('simple', ${text})
          order by ts_rank(
            to_tsvector('simple', s.content),
            websearch_to_tsquery('simple', ${text})
          ) desc
          limit ${poolSize}
        `)
      ).rows
    : [];

  const substringPool: PoolRow[] = text
    ? (
        await db.execute<PoolRow>(sql`
          select ${columns} ${sourceRelation}
            and (
              cm.content ilike ${`%${escapeLike(text)}%`}
              or s.content ilike ${`%${escapeLike(text)}%`}
            )
          order by cm.id asc
          limit ${poolSize}
        `)
      ).rows
    : [];

  const fused = new Map<number, SourceMessageSearchMatch>();
  const fuse = (rows: PoolRow[]) => {
    rows.forEach((row, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(Number(row.id));
      if (existing) existing.score += contribution;
      else fused.set(Number(row.id), { ...mapPoolRow(row), score: contribution });
    });
  };
  fuse(vectorPool);
  fuse(textPool);
  fuse(substringPool);

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, params.limit);
}

/** Escape LIKE metacharacters so a query term matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---- Summaries -------------------------------------------------------------

/** A stored topic summary, as served to the features. */
export interface SourceSummaryRecord {
  id: number;
  source: SourceId;
  chatId: string;
  summaryDate: string;
  content: string;
  messageIds: string[];
  createdAt: string;
  /** Whether the row carries an embedding (is semantically searchable). */
  embedded: boolean;
}

function mapSummaryRow(row: SourceSummaryRow): SourceSummaryRecord {
  return {
    id: row.id,
    source: row.source,
    chatId: row.chatId,
    summaryDate: row.summaryDate,
    content: row.content,
    messageIds: row.messageIds ?? [],
    createdAt: row.createdAt.toISOString(),
    embedded: row.embedding != null,
  };
}

/** A summary search hit: the topic plus the fused relevance score. */
export interface SourceSummarySearchMatch extends SourceSummaryRecord {
  score: number;
}

/** A topic to store, with its embedding (null when embeddings are unconfigured). */
export interface InsertSourceSummary {
  content: string;
  messageIds: string[];
  embedding: number[] | null;
}

/**
 * Replace a day's topics atomically. Replacing rather than appending is
 * what makes a re-run idempotent; the job's coverage markers stay with the
 * feature that runs it.
 */
export async function replaceSourceSummariesForDay(
  chat: SourceChatKey,
  input: { summaryDate: string; topics: readonly InsertSourceSummary[] },
  db: StoreDb = getStoreDb(),
): Promise<SourceSummaryRecord[]> {
  return db.transaction(async (tx) => {
    await tx
      .delete(sourceSummaries)
      .where(
        and(
          eq(sourceSummaries.source, chat.source),
          eq(sourceSummaries.chatId, chat.chatId),
          eq(sourceSummaries.summaryDate, input.summaryDate),
        ),
      );
    const rows =
      input.topics.length > 0
        ? await tx
            .insert(sourceSummaries)
            .values(
              input.topics.map((topic) => ({
                source: chat.source,
                chatId: chat.chatId,
                summaryDate: input.summaryDate,
                content: topic.content,
                messageIds: topic.messageIds,
                embedding: topic.embedding,
              })),
            )
            .returning()
        : [];
    return rows.map(mapSummaryRow);
  });
}

/** A chat's stored topics, newest day first (the dashboard view). */
export async function listSourceChatSummaries(
  chat: SourceChatKey,
  limit = 200,
  /** Restrict to one day's topics (the insight job's extra-context read). */
  date?: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceSummaryRecord[]> {
  const scoped = and(
    eq(sourceSummaries.source, chat.source),
    eq(sourceSummaries.chatId, chat.chatId),
  );
  const where = date ? and(scoped, eq(sourceSummaries.summaryDate, date)) : scoped;
  const rows = await db
    .select()
    .from(sourceSummaries)
    .where(where)
    .orderBy(desc(sourceSummaries.summaryDate), asc(sourceSummaries.id))
    .limit(limit);
  return rows.map(mapSummaryRow);
}

/** Per-chat topic counts across the listed sources, for the History overview. */
export async function countSourceSummariesByChat(
  sources: readonly SourceId[],
  db: StoreDb = getStoreDb(),
): Promise<(SourceChatKey & { topicCount: number })[]> {
  const rows = await db
    .select({
      source: sourceSummaries.source,
      chatId: sourceSummaries.chatId,
      topicCount: sql<number>`count(*)::int`,
    })
    .from(sourceSummaries)
    .where(sourceIn(sql`${sourceSummaries.source}`, sources))
    .groupBy(sourceSummaries.source, sourceSummaries.chatId);
  return rows.map((row) => ({ source: row.source, chatId: row.chatId, topicCount: row.topicCount }));
}

/**
 * Hybrid search over one chat's summaries: semantic fused with lexical by
 * reciprocal rank. With no query vector this degrades to pure full text
 * rather than returning nothing.
 */
export async function searchSourceSummariesHybrid(
  chat: SourceChatKey,
  params: {
    queryText: string;
    queryVector: number[] | null;
    limit: number;
  },
  db: StoreDb = getStoreDb(),
): Promise<SourceSummarySearchMatch[]> {
  const poolSize = Math.max(params.limit * 4, 20);
  const scoped = and(
    eq(sourceSummaries.source, chat.source),
    eq(sourceSummaries.chatId, chat.chatId),
  );

  const vectorRows: SourceSummaryRow[] = params.queryVector
    ? await db
        .select()
        .from(sourceSummaries)
        .where(and(scoped, sql`${sourceSummaries.embedding} is not null`))
        .orderBy(sql`${sourceSummaries.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`)
        .limit(poolSize)
    : [];

  const text = params.queryText.trim();
  const textRows: SourceSummaryRow[] = text
    ? await db
        .select()
        .from(sourceSummaries)
        .where(
          and(
            scoped,
            sql`to_tsvector('simple', ${sourceSummaries.content}) @@ websearch_to_tsquery('simple', ${text})`,
          ),
        )
        .orderBy(
          desc(
            sql`ts_rank(to_tsvector('simple', ${sourceSummaries.content}), websearch_to_tsquery('simple', ${text}))`,
          ),
        )
        .limit(poolSize)
    : [];

  const fused = new Map<number, SourceSummarySearchMatch>();
  const fuse = (rows: SourceSummaryRow[]) => {
    rows.forEach((row, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(row.id);
      if (existing) existing.score += contribution;
      else fused.set(row.id, { ...mapSummaryRow(row), score: contribution });
    });
  };
  fuse(vectorRows);
  fuse(textRows);

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, params.limit);
}

/** One (chat, day)'s visible message count, in the given zone's calendar. */
export interface SourceChatDayCount extends SourceChatKey {
  /** `YYYY-MM-DD` in the requested timezone. */
  date: string;
  messageCount: number;
}

/**
 * Per-(chat, day) visible message counts for every day strictly before
 * `before` — the summarizer's half of the day scan (its markers live with
 * the feature). Days bucket by the operator's wall clock.
 */
export async function listSourceChatDayCounts(
  sources: readonly SourceId[],
  params: { timeZone: string; before: string },
  db: StoreDb = getStoreDb(),
): Promise<SourceChatDayCount[]> {
  const rows = await db.execute<{
    source: string;
    chat_id: string;
    day: string;
    message_count: number;
  }>(sql`
    with days as (
      select
        source,
        chat_id,
        to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') as day,
        count(*)::int as message_count
      from source_messages
      where ${sourceIn(sql`source`, sources)} and deleted_at is null
      group by 1, 2, 3
    )
    select source, chat_id, day, message_count
    from days
    where day < ${params.before}
    order by day asc, source asc, chat_id asc
  `);
  return rows.rows.map((row) => ({
    source: row.source,
    chatId: row.chat_id,
    date: row.day,
    messageCount: Number(row.message_count),
  }));
}

// ---- Search index ----------------------------------------------------------

/** A message the indexing job still owes work on, with everything the text needs. */
export interface SourceUnindexedMessage extends SourceChatKey {
  sourceMessageId: string;
  content: string;
  /** The message's media, when it has any — its annotation is part of the text. */
  media: { kind: string; status: string; description: string | null } | null;
}

/** One built index row, ready to store. `embedding` is null when unconfigured. */
export interface SourceIndexedMessage extends SourceChatKey {
  sourceMessageId: string;
  content: string;
  embedding: number[] | null;
}

/**
 * The `where` shared by the due-scan and its count: a message is due when it
 * has no index row, or when either of its two sources changed after the row
 * was built. The second half matters most: a photo is mirrored the moment it
 * arrives, but its description lands minutes or hours later — `described_at`
 * is what re-indexes it automatically.
 */
const DUE_CONDITION = sql`
  s.chat_id is null
  or (m.described_at is not null and m.described_at > s.indexed_at)
  or (cm.edited_at is not null and cm.edited_at > s.indexed_at)
`;

const DUE_JOINS = sql`
  from source_messages cm
  left join source_media m
    on m.source = cm.source and m.chat_id = cm.chat_id and m.source_message_id = cm.source_message_id
  left join source_message_search s
    on s.source = cm.source and s.chat_id = cm.chat_id and s.source_message_id = cm.source_message_id
`;

/** Messages needing (re)indexing, oldest first, capped at `limit`. */
export async function listSourceMessagesNeedingIndex(
  sources: readonly SourceId[],
  limit: number,
  db: StoreDb = getStoreDb(),
): Promise<SourceUnindexedMessage[]> {
  const rows = await db.execute<{
    source: string;
    chat_id: string;
    source_message_id: string;
    content: string;
    kind: string | null;
    status: string | null;
    description: string | null;
  }>(sql`
    select
      cm.source,
      cm.chat_id,
      cm.source_message_id,
      cm.content,
      m.kind,
      m.status,
      m.description
    ${DUE_JOINS}
    where ${sourceIn(sql`cm.source`, sources)} and cm.deleted_at is null and (${DUE_CONDITION})
    order by cm.id asc
    limit ${limit}
  `);

  return rows.rows.map((row) => ({
    source: row.source,
    chatId: row.chat_id,
    sourceMessageId: row.source_message_id,
    content: row.content,
    media: row.kind
      ? { kind: row.kind, status: row.status ?? "pending", description: row.description }
      : null,
  }));
}

/** How many messages are still awaiting indexing — the dashboard's backlog size. */
export async function countSourceMessagesNeedingIndex(
  sources: readonly SourceId[],
  db: StoreDb = getStoreDb(),
): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    ${DUE_JOINS}
    where ${sourceIn(sql`cm.source`, sources)} and cm.deleted_at is null and (${DUE_CONDITION})
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * Store built index rows, replacing any previous ones. Upsert rather than
 * insert-or-skip: a re-index exists precisely because the text changed.
 */
export async function upsertSourceMessageIndex(
  rows: readonly SourceIndexedMessage[],
  db: StoreDb = getStoreDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(sourceMessageSearch)
    .values(
      rows.map((row) => ({
        source: row.source,
        chatId: row.chatId,
        sourceMessageId: row.sourceMessageId,
        content: row.content,
        embedding: row.embedding,
        indexedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [
        sourceMessageSearch.source,
        sourceMessageSearch.chatId,
        sourceMessageSearch.sourceMessageId,
      ],
      set: {
        content: sql`excluded.content`,
        embedding: sql`excluded.embedding`,
        indexedAt: sql`excluded.indexed_at`,
      },
    });
}

/** How many of a chat's messages are semantically searchable (have a vector). */
export async function countEmbeddedSourceMessages(
  chat: SourceChatKey,
  db: StoreDb = getStoreDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceMessageSearch)
    .where(
      and(
        eq(sourceMessageSearch.source, chat.source),
        eq(sourceMessageSearch.chatId, chat.chatId),
        sql`${sourceMessageSearch.embedding} is not null`,
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Empty the listed sources' index so every message is rebuilt from scratch —
 * the honest fix when embeddings were configured after messages were indexed.
 */
export async function clearSourceMessageIndex(
  sources: readonly SourceId[],
  db: StoreDb = getStoreDb(),
): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    with removed as (
      delete from source_message_search where ${sourceIn(sql`source`, sources)} returning 1
    )
    select count(*)::int as count from removed
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

// ---- Analytics -------------------------------------------------------------

export type SourceBucketUnit = "hour" | "day" | "week" | "month" | "year" | "all";

/** The `to_char` format matching the analytics bucket keys. */
function bucketFormat(unit: SourceBucketUnit): string {
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
function bucketExpr(column: SQL, unit: SourceBucketUnit, timeZone: string): SQL {
  if (unit === "all") return sql`'all'`;
  return sql`to_char(date_trunc(${unit}, (${column} at time zone ${timeZone})), ${bucketFormat(unit)})`;
}

/** Time/scope filter shared by the message aggregates (`to` exclusive). */
export interface SourceMessageScope {
  fromUtc: Date;
  toUtc: Date;
  /** One chat, or every chat of the listed sources. */
  chat?: SourceChatKey | null;
  /** One person's own messages, or everyone's. */
  user?: SourceUserKey | null;
}

/** The source half of a scope: the one chat's or person's source, else the whole roster. */
function scopeSourceWhere(
  sources: readonly SourceId[],
  scope: { chat?: SourceChatKey | null; user?: SourceUserKey | null },
): SQL[] {
  if (scope.chat) return [sql`source = ${scope.chat.source}`, sql`chat_id = ${scope.chat.chatId}`];
  if (scope.user) return [sql`source = ${scope.user.source}`, sql`user_id = ${scope.user.userId}`];
  return [sourceIn(sql`source`, sources)];
}

function messageWhere(sources: readonly SourceId[], scope: SourceMessageScope): SQL {
  const parts: SQL[] = [
    ...scopeSourceWhere(sources, scope),
    sql`deleted_at is null`,
    sql`sent_at >= ${scope.fromUtc}`,
    sql`sent_at < ${scope.toUtc}`,
  ];
  return sql.join(parts, sql` and `);
}

export interface SourceMessageSeriesRow {
  bucket: string;
  human: number;
  bot: number;
  activeUsers: number;
}

/** Per-bucket message volume and active users. */
export async function getSourceMessageSeries(
  sources: readonly SourceId[],
  params: SourceMessageScope & { unit: SourceBucketUnit; timeZone: string },
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageSeriesRow[]> {
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
    from source_messages
    where ${messageWhere(sources, params)}
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
export async function getSourceNewUserSeries(
  sources: readonly SourceId[],
  params: { fromUtc: Date; toUtc: Date; unit: SourceBucketUnit; timeZone: string },
  db: StoreDb = getStoreDb(),
): Promise<{ bucket: string; newUsers: number }[]> {
  const bucket = bucketExpr(sql`first_seen_at`, params.unit, params.timeZone);
  const rows = await db.execute<{ bucket: string; new_users: number }>(sql`
    select ${bucket} as bucket, count(*)::int as new_users
    from source_users
    where ${sourceIn(sql`source`, sources)}
      and first_seen_at >= ${params.fromUtc} and first_seen_at < ${params.toUtc}
    group by 1
  `);
  return rows.rows.map((r) => ({ bucket: r.bucket, newUsers: Number(r.new_users) }));
}

/** The most active human senders in the period (optionally within one chat). */
export async function getSourceTopUsers(
  sources: readonly SourceId[],
  params: { fromUtc: Date; toUtc: Date; chat?: SourceChatKey | null; limit: number },
  db: StoreDb = getStoreDb(),
): Promise<(SourceUserKey & { messages: number })[]> {
  const parts: SQL[] = [
    ...scopeSourceWhere(sources, params),
    sql`deleted_at is null`,
    sql`role = 'user'`,
    sql`user_id is not null`,
    sql`sent_at >= ${params.fromUtc}`,
    sql`sent_at < ${params.toUtc}`,
  ];
  const rows = await db.execute<{ source: string; user_id: string; messages: number }>(sql`
    select source, user_id, count(*)::int as messages
    from source_messages
    where ${sql.join(parts, sql` and `)}
    group by source, user_id
    order by messages desc
    limit ${params.limit}
  `);
  return rows.rows.map((r) => ({
    source: r.source,
    userId: r.user_id,
    messages: Number(r.messages),
  }));
}

/** Bucket keys in a range that hold any message — the calendar's data marks. */
export async function getSourceMessageAvailability(
  sources: readonly SourceId[],
  params: {
    fromUtc: Date;
    toUtc: Date;
    unit: SourceBucketUnit;
    timeZone: string;
    chat?: SourceChatKey | null;
  },
  db: StoreDb = getStoreDb(),
): Promise<string[]> {
  const bucket = bucketExpr(sql`sent_at`, params.unit, params.timeZone);
  const parts: SQL[] = [
    ...scopeSourceWhere(sources, params),
    sql`deleted_at is null`,
    sql`sent_at >= ${params.fromUtc}`,
    sql`sent_at < ${params.toUtc}`,
  ];
  const rows = await db.execute<{ bucket: string }>(sql`
    select distinct ${bucket} as bucket
    from source_messages
    where ${sql.join(parts, sql` and `)}
    order by 1
  `);
  return rows.rows.map((r) => r.bucket);
}

export interface SourceChatHourCount extends SourceChatKey {
  /** `YYYY-MM-DD HH24` in the requested timezone. */
  insightHour: string;
  messageCount: number;
}

/**
 * Every (chat, wall-clock hour) pair holding visible messages, with counts —
 * the insight due-scan's source half. `fromUtc` is the scan floor applied to
 * raw `sent_at`, so rows below it skip the per-row timezone expression.
 */
export async function listSourceChatHourCounts(
  sources: readonly SourceId[],
  params: { timeZone: string; fromUtc?: Date },
  db: StoreDb = getStoreDb(),
): Promise<SourceChatHourCount[]> {
  const floor = params.fromUtc ? sql`and sent_at >= ${params.fromUtc}` : sql``;
  const rows = await db.execute<{
    source: string;
    chat_id: string;
    insight_hour: string;
    message_count: number;
  }>(sql`
    select
      source,
      chat_id,
      to_char(date_trunc('hour', (sent_at at time zone ${params.timeZone})), 'YYYY-MM-DD HH24') as insight_hour,
      count(*)::int as message_count
    from source_messages
    where ${sourceIn(sql`source`, sources)} and deleted_at is null ${floor}
    group by 1, 2, 3
    order by 3 asc, 1 asc, 2 asc
  `);
  return rows.rows.map((r) => ({
    source: r.source,
    chatId: r.chat_id,
    insightHour: r.insight_hour,
    messageCount: Number(r.message_count),
  }));
}
