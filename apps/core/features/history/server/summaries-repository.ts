import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatSummaries, chatSummaryDays, type ChatSummaryRow } from "@/db/schema";
import type { SummaryDate } from "../summary";

/**
 * Typed persistence for the daily topic summaries (`chat_summaries`) and the
 * per-day processing markers (`chat_summary_days`). Pure data access — no LLM, no
 * embedding, no tracing; the service owns those.
 */

/** A stored topic summary. */
export interface ChatSummaryRecord {
  id: number;
  chatId: string;
  summaryDate: SummaryDate;
  content: string;
  messageIds: number[];
  createdAt: string;
  /** Whether the row carries an embedding (i.e. is semantically searchable). */
  embedded: boolean;
}

/** A topic to store, with its embedding (null when embeddings are unconfigured). */
export interface InsertChatSummary {
  content: string;
  messageIds: number[];
  embedding: number[] | null;
}

/** A (chat, day) pair the summarizer still owes work on. */
export interface PendingSummaryDay {
  chatId: string;
  summaryDate: SummaryDate;
  /** Messages the day currently holds — what the marker will record once summarized. */
  messageCount: number;
}

function mapRow(row: ChatSummaryRow): ChatSummaryRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    summaryDate: row.summaryDate,
    content: row.content,
    messageIds: row.messageIds ?? [],
    createdAt: row.createdAt.toISOString(),
    embedded: row.embedding != null,
  };
}

/**
 * Replace a day's topics and stamp its marker, atomically. Replacing (rather than
 * appending) is what makes a re-run idempotent: summarizing the same day twice
 * leaves one set of topics, not two. The marker is written even for a day that
 * distilled to *nothing*, so a chat-day of pure noise is never re-summarized on
 * every run forever.
 */
export async function replaceSummariesForDay(
  db: DrizzleDb,
  input: {
    chatId: string;
    summaryDate: SummaryDate;
    messageCount: number;
    topics: readonly InsertChatSummary[];
  },
): Promise<ChatSummaryRecord[]> {
  return db.transaction(async (tx) => {
    await tx
      .delete(chatSummaries)
      .where(
        and(
          eq(chatSummaries.chatId, input.chatId),
          eq(chatSummaries.summaryDate, input.summaryDate),
        ),
      );

    const rows =
      input.topics.length > 0
        ? await tx
            .insert(chatSummaries)
            .values(
              input.topics.map((topic) => ({
                chatId: input.chatId,
                summaryDate: input.summaryDate,
                content: topic.content,
                messageIds: topic.messageIds,
                embedding: topic.embedding,
              })),
            )
            .returning()
        : [];

    const marker = {
      chatId: input.chatId,
      summaryDate: input.summaryDate,
      messageCount: input.messageCount,
      topicCount: input.topics.length,
      summarizedAt: new Date(),
    };
    await tx
      .insert(chatSummaryDays)
      .values(marker)
      .onConflictDoUpdate({
        target: [chatSummaryDays.chatId, chatSummaryDays.summaryDate],
        set: marker,
      });

    return rows.map(mapRow);
  });
}

/**
 * (chat, day) pairs that need summarizing: every finished day holding messages,
 * whose marker is missing or whose recorded message count no longer matches the
 * day's live count.
 *
 * The count comparison is what makes the job self-healing rather than
 * fire-and-forget: history imported from a CSV, or a day that gained a late edit,
 * is picked up on the next run — while an unchanged day is never re-spent on the
 * LLM. Days are bucketed by the operator's wall clock (`AT TIME ZONE`), matching
 * how the summaries are dated and how a person would ask for them.
 *
 * `today` (the operator's current date) is excluded: it is unfinished, and every
 * reply already carries it verbatim.
 */
export async function listDaysNeedingSummary(
  db: DrizzleDb,
  params: { timeZone: string; today: SummaryDate; limit: number },
): Promise<PendingSummaryDay[]> {
  const rows = await db.execute<{
    chat_id: string;
    summary_date: string;
    message_count: number;
  }>(sql`
    with days as (
      select
        chat_id,
        to_char((sent_at at time zone ${params.timeZone})::date, 'YYYY-MM-DD') as summary_date,
        count(*)::int as message_count
      from chat_messages
      where deleted_at is null
      group by 1, 2
    )
    select days.chat_id, days.summary_date, days.message_count
    from days
    left join chat_summary_days m
      on m.chat_id = days.chat_id and m.summary_date = days.summary_date
    where days.summary_date < ${params.today}
      and (m.id is null or m.message_count <> days.message_count)
    order by days.summary_date asc, days.chat_id asc
    limit ${params.limit}
  `);

  return rows.rows.map((row) => ({
    chatId: row.chat_id,
    summaryDate: row.summary_date,
    messageCount: Number(row.message_count),
  }));
}

/** How many (chat, day) pairs are still awaiting summarization — for the dashboard. */
export async function countDaysNeedingSummary(
  db: DrizzleDb,
  params: { timeZone: string; today: SummaryDate },
): Promise<number> {
  const pending = await listDaysNeedingSummary(db, { ...params, limit: 10_000 });
  return pending.length;
}

/** A chat's stored topics, newest day first (the dashboard view). */
export async function listChatSummaries(
  db: DrizzleDb,
  chatId: string,
  limit = 200,
): Promise<ChatSummaryRecord[]> {
  const rows = await db
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.chatId, chatId))
    .orderBy(desc(chatSummaries.summaryDate), asc(chatSummaries.id))
    .limit(limit);
  return rows.map(mapRow);
}

/** Per-chat topic counts, for the History overview. */
export async function countSummariesByChat(db: DrizzleDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      chatId: chatSummaries.chatId,
      topicCount: sql<number>`count(*)::int`,
    })
    .from(chatSummaries)
    .groupBy(chatSummaries.chatId);
  return new Map(rows.map((row) => [row.chatId, row.topicCount]));
}

/** A search hit: the topic plus the fused relevance score that ranked it. */
export interface SummaryMatch extends ChatSummaryRecord {
  score: number;
}

/** Reciprocal-rank-fusion damping constant — the standard k=60 from the RRF paper. */
const RRF_K = 60;

/**
 * Hybrid search over one chat's summaries: semantic (cosine distance over the
 * embedding) fused with lexical (Postgres full text) by reciprocal rank.
 *
 * Neither half suffices alone. Vectors find "the thing about the broken deploy"
 * when nobody used those words, but miss exact rare tokens (a name, an error
 * code); full text nails those tokens but is blind to paraphrase. RRF combines
 * them by *rank* rather than score, so the two incomparable scales (cosine
 * distance vs `ts_rank`) never have to be normalized against each other.
 *
 * With no embedding configured (`queryVector` null) this degrades to pure full
 * text rather than returning nothing — the summaries are still written and still
 * searchable, just not semantically.
 */
export async function searchChatSummaries(
  db: DrizzleDb,
  params: {
    chatId: string;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
  },
): Promise<SummaryMatch[]> {
  // Pull a deeper pool from each half than we return: a result ranked #10 by one
  // half and #12 by the other should be able to win overall, which it cannot if
  // each half only offers its top few.
  const poolSize = Math.max(params.limit * 4, 20);

  const vectorRows: ChatSummaryRow[] = params.queryVector
    ? await db
        .select()
        .from(chatSummaries)
        .where(
          and(
            eq(chatSummaries.chatId, params.chatId),
            sql`${chatSummaries.embedding} is not null`,
          ),
        )
        .orderBy(sql`${chatSummaries.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`)
        .limit(poolSize)
    : [];

  const text = params.queryText.trim();
  const textRows: ChatSummaryRow[] = text
    ? await db
        .select()
        .from(chatSummaries)
        .where(
          and(
            eq(chatSummaries.chatId, params.chatId),
            sql`to_tsvector('simple', ${chatSummaries.content}) @@ websearch_to_tsquery('simple', ${text})`,
          ),
        )
        .orderBy(
          desc(
            sql`ts_rank(to_tsvector('simple', ${chatSummaries.content}), websearch_to_tsquery('simple', ${text}))`,
          ),
        )
        .limit(poolSize)
    : [];

  const fused = new Map<number, SummaryMatch>();
  const fuse = (rows: ChatSummaryRow[]) => {
    rows.forEach((row, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(row.id);
      if (existing) existing.score += contribution;
      else fused.set(row.id, { ...mapRow(row), score: contribution });
    });
  };
  fuse(vectorRows);
  fuse(textRows);

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, params.limit);
}
