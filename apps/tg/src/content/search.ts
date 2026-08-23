import { and, desc, eq, sql } from "drizzle-orm";

import { summaries, type SummaryRow } from "../../store/schema";
import type { TgDb } from "../db";

/**
 * Hybrid search over this app's conversation content — the v1
 * `search-repository.ts` / `summaries-repository.ts` search halves ported
 * onto this store's table names (messages / message_search / media /
 * summaries). The SQL lives with the data and its indexes; the core
 * supplies the query text and, when embeddings are configured, the query
 * vector — models never run here.
 */

/** Filters a message search may narrow by, beyond the query itself. */
export interface MessageSearchFilters {
  /** Only messages from these senders (Telegram user ids). Empty/absent → anyone. */
  authorUserIds?: string[];
  /** Only messages carrying media of these kinds. Absent → any message. */
  mediaKinds?: string[];
}

/** A search hit: the message row, the text that matched, and its fused score. */
export interface MessageSearchMatch {
  id: number;
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToMessageId: number | null;
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
  chat_id: string;
  telegram_message_id: string | number;
  role: string;
  user_id: string | null;
  content: string;
  reply_to_message_id: string | number | null;
  sent_at: Date | string;
  edited_at: Date | string | null;
  bot_reaction: string | null;
  created_at: Date | string;
  indexed_content: string | null;
  media_kind: string | null;
}

/**
 * Timestamps from a raw `db.execute` come back as strings, not `Date` — the
 * driver's type parsing is not applied to an untyped statement. Tolerating
 * both keeps this mapper honest about what it is actually given.
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPoolRow(row: PoolRow): Omit<MessageSearchMatch, "score"> {
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    telegramMessageId: Number(row.telegram_message_id),
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.user_id,
    content: row.content,
    replyToMessageId: row.reply_to_message_id == null ? null : Number(row.reply_to_message_id),
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
 * pools because they cover different failures — see the v1 module notes,
 * which apply verbatim. `chatId: null` searches every chat (operator
 * search); the assistant's own tool always passes its bound chat.
 */
export async function searchMessagesHybrid(
  db: TgDb,
  params: {
    chatId: string | null;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
    filters?: MessageSearchFilters;
  },
): Promise<MessageSearchMatch[]> {
  const text = params.queryText.trim();

  // Pull a deeper pool from each half than we return: a result ranked #10 by
  // one half and #12 by another should be able to win overall, which it
  // cannot if each half only offers its top few.
  const poolSize = Math.max(params.limit * 4, 20);

  const authorIds = params.filters?.authorUserIds ?? [];
  const kinds = params.filters?.mediaKinds ?? [];
  // An array in a `sql` template expands to a comma-separated *parameter
  // list* (`$2, $3, …`), not one array-typed parameter — so `in (…)` works
  // and `= any(?::text[])` fails at runtime with "malformed array literal".
  const authorFilter = authorIds.length > 0 ? sql`and cm.user_id in (${authorIds})` : sql``;
  const kindFilter = kinds.length > 0 ? sql`and mm.kind in (${kinds})` : sql``;
  const chatFilter = params.chatId != null ? sql`and cm.chat_id = ${params.chatId}` : sql``;

  /** The visible messages in scope, joined to what a hit needs to explain itself. */
  const source = sql`
    from messages cm
    left join message_search s
      on s.chat_id = cm.chat_id and s.telegram_message_id = cm.telegram_message_id
    left join media mm
      on mm.chat_id = cm.chat_id and mm.telegram_message_id = cm.telegram_message_id
    where cm.deleted_at is null
      ${chatFilter}
      ${authorFilter}
      ${kindFilter}
  `;
  const columns = sql`
    cm.id, cm.chat_id, cm.telegram_message_id, cm.role, cm.user_id, cm.content,
    cm.reply_to_message_id, cm.sent_at, cm.edited_at, cm.bot_reaction, cm.created_at,
    s.content as indexed_content, mm.kind as media_kind
  `;

  // Filters with no query at all — "the photos she sent". A legitimate
  // lookup with nothing to rank by, so it answers with the most recent
  // matches instead of nothing (v1 production lesson, 2026-08-07).
  if (!text && !params.queryVector) {
    if (authorIds.length === 0 && kinds.length === 0) return [];
    const rows = await db.execute<PoolRow>(sql`
      select ${columns} ${source}
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
          select ${columns} ${source}
            and s.embedding is not null
          order by s.embedding <=> ${JSON.stringify(params.queryVector)}::vector
          limit ${poolSize}
        `)
      ).rows
    : [];

  const textPool: PoolRow[] = text
    ? (
        await db.execute<PoolRow>(sql`
          select ${columns} ${source}
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
          select ${columns} ${source}
            and (
              cm.content ilike ${`%${escapeLike(text)}%`}
              or s.content ilike ${`%${escapeLike(text)}%`}
            )
          order by cm.id asc
          limit ${poolSize}
        `)
      ).rows
    : [];

  const fused = new Map<number, MessageSearchMatch>();
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

/** A stored topic summary, as served to the core. */
export interface SummaryRecord {
  id: number;
  chatId: string;
  summaryDate: string;
  content: string;
  messageIds: number[];
  createdAt: string;
  /** Whether the row carries an embedding (is semantically searchable). */
  embedded: boolean;
}

export function mapSummaryRow(row: SummaryRow): SummaryRecord {
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

/** A summary search hit: the topic plus the fused relevance score. */
export interface SummarySearchMatch extends SummaryRecord {
  score: number;
}

/**
 * Hybrid search over one chat's summaries: semantic fused with lexical by
 * reciprocal rank (v1 semantics verbatim). With no query vector this
 * degrades to pure full text rather than returning nothing.
 */
export async function searchSummariesHybrid(
  db: TgDb,
  params: {
    chatId: string;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
  },
): Promise<SummarySearchMatch[]> {
  const poolSize = Math.max(params.limit * 4, 20);

  const vectorRows: SummaryRow[] = params.queryVector
    ? await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.chatId, params.chatId), sql`${summaries.embedding} is not null`))
        .orderBy(sql`${summaries.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`)
        .limit(poolSize)
    : [];

  const text = params.queryText.trim();
  const textRows: SummaryRow[] = text
    ? await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.chatId, params.chatId),
            sql`to_tsvector('simple', ${summaries.content}) @@ websearch_to_tsquery('simple', ${text})`,
          ),
        )
        .orderBy(
          desc(
            sql`ts_rank(to_tsvector('simple', ${summaries.content}), websearch_to_tsquery('simple', ${text}))`,
          ),
        )
        .limit(poolSize)
    : [];

  const fused = new Map<number, SummarySearchMatch>();
  const fuse = (rows: SummaryRow[]) => {
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
