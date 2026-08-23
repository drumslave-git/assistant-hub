import { and, eq, sql } from "drizzle-orm";

import { messageSearch } from "../../store/schema";
import type { TgDb } from "../db";

/**
 * The message search index's persistence — the v1 `search-repository.ts`
 * indexing half ported onto this store. The core's indexing job composes
 * each message's searchable text and embeds it; this side owns the due
 * scan (which rows the job still owes work on) and the row writes.
 */

/** A message the indexing job still owes work on, with everything the text needs. */
export interface UnindexedMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  /** The message's media, when it has any — its annotation is part of the text. */
  media: { kind: string; status: string; description: string | null } | null;
}

/** One built index row, ready to store. `embedding` is null when unconfigured. */
export interface IndexedMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  embedding: number[] | null;
}

/**
 * The `where` shared by the due-scan and its count: a message is due when it
 * has no index row, or when either of its two sources changed after the row
 * was built. The second half matters most in practice: a photo is mirrored
 * the moment it arrives, but its description lands minutes or hours later —
 * `described_at` is what re-indexes it automatically (v1 note, verbatim).
 */
const DUE_CONDITION = sql`
  s.chat_id is null
  or (m.described_at is not null and m.described_at > s.indexed_at)
  or (cm.edited_at is not null and cm.edited_at > s.indexed_at)
`;

/** Messages needing (re)indexing, oldest first, capped at `limit`. */
export async function listMessagesNeedingIndex(
  db: TgDb,
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
    from messages cm
    left join media m
      on m.chat_id = cm.chat_id and m.telegram_message_id = cm.telegram_message_id
    left join message_search s
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
      ? { kind: row.kind, status: row.status ?? "pending", description: row.description }
      : null,
  }));
}

/** How many messages are still awaiting indexing — the dashboard's backlog size. */
export async function countMessagesNeedingIndex(db: TgDb): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from messages cm
    left join media m
      on m.chat_id = cm.chat_id and m.telegram_message_id = cm.telegram_message_id
    left join message_search s
      on s.chat_id = cm.chat_id and s.telegram_message_id = cm.telegram_message_id
    where cm.deleted_at is null and (${DUE_CONDITION})
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * Store built index rows, replacing any previous ones. Upsert rather than
 * insert-or-skip: a re-index exists precisely because the text changed, so
 * the old row (and its now-wrong vector) must go.
 */
export async function upsertMessageIndex(
  db: TgDb,
  rows: readonly IndexedMessage[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(messageSearch)
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
      target: [messageSearch.chatId, messageSearch.telegramMessageId],
      set: {
        content: sql`excluded.content`,
        embedding: sql`excluded.embedding`,
        indexedAt: sql`excluded.indexed_at`,
      },
    });
}

/** How many of a chat's messages are semantically searchable (have a vector). */
export async function countEmbeddedMessages(db: TgDb, chatId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messageSearch)
    .where(and(eq(messageSearch.chatId, chatId), sql`${messageSearch.embedding} is not null`));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Empty the index so every message is rebuilt from scratch — the honest fix
 * when embeddings were configured after messages were indexed (v1 note).
 */
export async function clearMessageIndex(db: TgDb): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    with removed as (delete from message_search returning 1)
    select count(*)::int as count from removed
  `);
  return Number(rows.rows[0]?.count ?? 0);
}
