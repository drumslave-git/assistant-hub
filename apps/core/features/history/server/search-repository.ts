import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatMessageSearch } from "@/db/schema";
import type { MediaKind, MediaStatus } from "@/features/vision/types";

import type { ChatMessageRecord } from "./repository";

/**
 * Typed persistence for the message search index (`chat_message_search`) and the
 * hybrid lookup that reads it. Pure data access — the job owns embedding, the
 * service owns tracing.
 */

/** A message the indexing job still owes work on, with everything the text needs. */
export interface UnindexedMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  /** The message's media, when it has any — its annotation is part of the text. */
  media: { kind: MediaKind; status: MediaStatus; description: string | null } | null;
}

/** One built index row, ready to store. `embedding` is null when unconfigured. */
export interface IndexedMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  embedding: number[] | null;
}

/**
 * The `where` shared by the due-scan and its count: a message is due when it has
 * no index row, or when either of its two sources changed after the row was
 * built.
 *
 * The second half is the one that matters in practice. A photo is mirrored the
 * moment it arrives, but its description is written minutes or hours later by the
 * vision backfill — so almost every media message is indexed once as bare
 * `[photo]` and must be picked up again once it can actually say what it shows.
 * `described_at` is what makes that automatic instead of a one-shot the operator
 * has to remember to re-run.
 */
const DUE_CONDITION = sql`
  s.chat_id is null
  or (m.described_at is not null and m.described_at > s.indexed_at)
  or (cm.edited_at is not null and cm.edited_at > s.indexed_at)
`;

/**
 * Messages needing (re)indexing, oldest first, capped at `limit`. Deleted rows
 * are skipped — they are invisible to every reader, so indexing them would only
 * spend embedding calls on text nothing can return.
 */
export async function listMessagesNeedingIndex(
  db: DrizzleDb,
  limit: number,
): Promise<UnindexedMessage[]> {
  const rows = await db.execute<{
    chat_id: string;
    telegram_message_id: string | number;
    content: string;
    kind: string | null;
    status: string | null;
    description: string | null;
  }>(sql`
    select
      cm.chat_id,
      cm.telegram_message_id,
      cm.content,
      m.kind,
      m.status,
      m.description
    from chat_messages cm
    left join message_media m
      on m.chat_id = cm.chat_id and m.telegram_message_id = cm.telegram_message_id
    left join chat_message_search s
      on s.chat_id = cm.chat_id and s.telegram_message_id = cm.telegram_message_id
    where cm.deleted_at is null and (${DUE_CONDITION})
    order by cm.id asc
    limit ${limit}
  `);

  return rows.rows.map((row) => ({
    chatId: row.chat_id,
    telegramMessageId: Number(row.telegram_message_id),
    content: row.content,
    media: row.kind
      ? {
          kind: row.kind as MediaKind,
          status: (row.status ?? "pending") as MediaStatus,
          description: row.description,
        }
      : null,
  }));
}

/** How many messages are still awaiting indexing — the dashboard's backlog size. */
export async function countMessagesNeedingIndex(db: DrizzleDb): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from chat_messages cm
    left join message_media m
      on m.chat_id = cm.chat_id and m.telegram_message_id = cm.telegram_message_id
    left join chat_message_search s
      on s.chat_id = cm.chat_id and s.telegram_message_id = cm.telegram_message_id
    where cm.deleted_at is null and (${DUE_CONDITION})
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * Store built index rows, replacing any previous ones. Upsert rather than
 * insert-or-skip: a re-index exists precisely because the text changed, so the
 * old row (and its now-wrong vector) must go.
 */
export async function upsertMessageIndex(
  db: DrizzleDb,
  rows: readonly IndexedMessage[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(chatMessageSearch)
    .values(
      rows.map((row) => ({
        chatId: row.chatId,
        telegramMessageId: row.telegramMessageId,
        content: row.content,
        embedding: row.embedding,
        indexedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [chatMessageSearch.chatId, chatMessageSearch.telegramMessageId],
      set: {
        content: sql`excluded.content`,
        embedding: sql`excluded.embedding`,
        indexedAt: sql`excluded.indexed_at`,
      },
    });
}

/** How many of a chat's messages are semantically searchable (have a vector). */
export async function countEmbeddedMessages(db: DrizzleDb, chatId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessageSearch)
    .where(
      and(eq(chatMessageSearch.chatId, chatId), sql`${chatMessageSearch.embedding} is not null`),
    );
  return Number(rows[0]?.count ?? 0);
}

/** Filters a search may narrow by, beyond the query itself. */
export interface MessageSearchFilters {
  /** Only messages from these senders (Telegram user ids). Empty/absent → anyone. */
  authorUserIds?: string[];
  /** Only messages carrying media of these kinds. Absent → any message. */
  mediaKinds?: MediaKind[];
}

/** A search hit: the message, the text that matched, and its fused score. */
export interface MessageSearchMatch extends ChatMessageRecord {
  /** The indexed text (message text + media annotation), when the row is indexed. */
  indexedContent: string | null;
  /** The message's media kind, or null for a plain text message. */
  mediaKind: MediaKind | null;
  score: number;
}

/** Reciprocal-rank-fusion damping constant — the standard k=60 from the RRF paper. */
const RRF_K = 60;

/**
 * Row shape shared by the three search pools. Snake-case because these run as
 * raw SQL (`db.execute`), which hands back the database's own column names rather
 * than the Drizzle camel-case mapping.
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
 * Timestamps from a raw `db.execute` come back as strings, not the `Date` the
 * Drizzle query builder hands back — the driver's type parsing is not applied to
 * an untyped statement. Tolerating both is what keeps this mapper honest about
 * what it is actually given.
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
    // The pools only ever select visible rows, so a hit is never a deleted one.
    deletedAt: null,
    botReaction: row.bot_reaction ?? null,
    createdAt: toIso(row.created_at),
    indexedContent: row.indexed_content,
    mediaKind: (row.media_kind as MediaKind | null) ?? null,
  };
}

/**
 * Hybrid search over one chat's messages: semantic (cosine distance over the
 * indexed embedding), lexical (Postgres full text over the indexed text), and
 * literal (case-insensitive substring), fused by reciprocal rank.
 *
 * Three pools rather than the summaries' two, because they cover different
 * failures. The vector half finds "the photo of the front door" when the photo
 * has no caption at all and only its vision description says `door` — the case
 * this search exists for. Full text nails exact rare tokens (a name, an error
 * code) that embeddings blur. The substring half is the behaviour `history_search`
 * has always had, and it stays because it is the only one that reads
 * `chat_messages` directly: a message sent five minutes ago has no index row yet,
 * and a search that could not find it would be a regression the other two halves
 * would hide.
 *
 * RRF combines them by *rank*, so three incomparable scales (cosine distance,
 * `ts_rank`, none at all) never have to be normalized against each other.
 *
 * `chatId: null` searches every chat at once — what the operator's dashboard
 * search does, since they are looking for a message without necessarily knowing
 * which conversation it was in. The bot's own `history_search` always passes the
 * chat it is bound to: a chat may never read another's messages.
 */
export async function searchChatMessagesHybrid(
  db: DrizzleDb,
  params: {
    /** The chat to search, or null for every chat (operator-side search only). */
    chatId: string | null;
    queryText: string;
    queryVector: number[] | null;
    limit: number;
    filters?: MessageSearchFilters;
  },
): Promise<MessageSearchMatch[]> {
  const text = params.queryText.trim();

  // Pull a deeper pool from each half than we return: a result ranked #10 by one
  // half and #12 by another should be able to win overall, which it cannot if
  // each half only offers its top few.
  const poolSize = Math.max(params.limit * 4, 20);

  const authorIds = params.filters?.authorUserIds ?? [];
  const kinds = params.filters?.mediaKinds ?? [];
  // An array in a `sql` template expands to a comma-separated *parameter list*
  // (`$2, $3, …`), not to one array-typed parameter — so `in (…)` is the form
  // that works here, and `= any(?::text[])` is the form that fails at runtime
  // with "malformed array literal".
  const authorFilter = authorIds.length > 0 ? sql`and cm.user_id in (${authorIds})` : sql``;
  const kindFilter = kinds.length > 0 ? sql`and mm.kind in (${kinds})` : sql``;
  const chatFilter = params.chatId != null ? sql`and cm.chat_id = ${params.chatId}` : sql``;

  /** The visible messages in scope, joined to the two things a hit needs to explain itself. */
  const source = sql`
    from chat_messages cm
    left join chat_message_search s
      on s.chat_id = cm.chat_id and s.telegram_message_id = cm.telegram_message_id
    left join message_media mm
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

  // Filters with no query at all — "the photos she sent". A legitimate lookup
  // with nothing to rank by, so it answers with the most recent matches instead
  // of nothing. Rejecting it forces the model to invent a query, and in
  // production (2026-08-07) that is exactly what happened: it retried without
  // the author filter and searched the whole chat.
  if (!text && !params.queryVector) {
    if (authorIds.length === 0 && kinds.length === 0) return [];
    const rows = await db.execute<PoolRow>(sql`
      select ${columns} ${source}
      order by cm.id desc
      limit ${params.limit}
    `);
    // Newest first while selecting, message order when returned — same contract
    // as a ranked search, so callers render one way.
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

/**
 * Empty the index so every message is rebuilt from scratch.
 *
 * The one case that needs it: embeddings were configured *after* messages were
 * indexed. Those rows are up to date by the staleness rule (nothing about the
 * message changed) and would therefore keep their null vector forever, leaving
 * the chat permanently lexical-only with nothing saying why. Rebuilding is the
 * honest fix, and cheap — the text is all still in the mirror.
 */
export async function clearMessageIndex(db: DrizzleDb): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    with removed as (delete from chat_message_search returning 1)
    select count(*)::int as count from removed
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/** Drop a message's index row (used when a message is purged in code, not by FK). */
export async function deleteMessageIndex(
  db: DrizzleDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<void> {
  if (telegramMessageIds.length === 0) return;
  await db
    .delete(chatMessageSearch)
    .where(
      and(
        eq(chatMessageSearch.chatId, chatId),
        inArray(chatMessageSearch.telegramMessageId, telegramMessageIds),
      ),
    );
}
