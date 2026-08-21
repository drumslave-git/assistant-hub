import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import {
  generalMemories,
  memoryEntries,
  userMemories,
  type GeneralMemoryRow,
  type MemoryEntryRow,
  type UserMemoryRow,
} from "@/db/schema";

import type { GeneralMemory, MemoryEntry, MemoryScope, UserMemory } from "../types";

/**
 * Typed persistence for memory. Pure data access: no LLM, no embedding, no
 * tracing, no policy — the service and the consolidation job own those.
 */

function mapEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    userId: row.userId,
    content: row.content,
    chatId: row.chatId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapUserMemory(row: UserMemoryRow): UserMemory {
  return {
    userId: row.userId,
    content: row.content,
    embedded: row.embedding != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapGeneralMemory(row: GeneralMemoryRow): GeneralMemory {
  return {
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------ pending queue */

/** Append one raw note from the `memory_save` tool. */
export async function addMemoryEntry(
  db: DrizzleDb,
  input: { scope: MemoryScope; userId: string | null; content: string; chatId: string | null },
): Promise<MemoryEntry> {
  const [row] = await db
    .insert(memoryEntries)
    .values({
      id: randomUUID(),
      scope: input.scope,
      userId: input.scope === "user" ? input.userId : null,
      content: input.content,
      chatId: input.chatId,
    })
    .returning();
  return mapEntry(row);
}

/** Every pending note, newest first (dashboard). */
export async function listMemoryEntries(db: DrizzleDb): Promise<MemoryEntry[]> {
  const rows = await db.query.memoryEntries.findMany({
    orderBy: (e, { desc: d }) => [d(e.createdAt)],
  });
  return rows.map(mapEntry);
}

/** Pending notes for one person, oldest first (the order they were learned). */
export async function getPendingUserEntries(
  db: DrizzleDb,
  userId: string,
): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.scope, "user"), eq(memoryEntries.userId, userId)))
    .orderBy(asc(memoryEntries.createdAt));
  return rows.map(mapEntry);
}

/** Pending `general` notes, oldest first. */
export async function getPendingGeneralEntries(db: DrizzleDb): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(eq(memoryEntries.scope, "general"))
    .orderBy(asc(memoryEntries.createdAt));
  return rows.map(mapEntry);
}

/** The distinct people who have pending notes — the consolidation job's user backlog. */
export async function listUsersWithPendingEntries(db: DrizzleDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: memoryEntries.userId })
    .from(memoryEntries)
    .where(and(eq(memoryEntries.scope, "user"), isNotNull(memoryEntries.userId)));
  return rows.map((r) => r.userId).filter((id): id is string => id != null);
}

/** How many notes are waiting for the next consolidation run (dashboard backlog). */
export async function countPendingEntries(db: DrizzleDb): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(memoryEntries);
  return row?.count ?? 0;
}

/** Drop notes by id (consolidated, or discarded by the operator). */
export async function deleteMemoryEntries(db: DrizzleDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(memoryEntries)
    .where(inArray(memoryEntries.id, ids))
    .returning({ id: memoryEntries.id });
  return rows.length;
}

/* --------------------------------------------------------------- user docs */

/** One person's consolidated document, or null when they have none yet. */
export async function getUserMemory(db: DrizzleDb, userId: string): Promise<UserMemory | null> {
  const row = await db.query.userMemories.findFirst({ where: eq(userMemories.userId, userId) });
  return row ? mapUserMemory(row) : null;
}

/** Several people's documents at once (reply-context injection). */
export async function getUserMemoriesFor(
  db: DrizzleDb,
  userIds: string[],
): Promise<UserMemory[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select()
    .from(userMemories)
    .where(inArray(userMemories.userId, userIds));
  return rows.map(mapUserMemory);
}

/** Every person's document, most recently updated first (dashboard). */
export async function listUserMemories(db: DrizzleDb): Promise<UserMemory[]> {
  const rows = await db.select().from(userMemories).orderBy(desc(userMemories.updatedAt));
  return rows.map(mapUserMemory);
}

/** Insert or rewrite one person's document (the nightly merge, or an operator edit). */
export async function upsertUserMemory(
  db: DrizzleDb,
  input: { userId: string; content: string; embedding: number[] | null },
): Promise<UserMemory> {
  const now = new Date();
  const [row] = await db
    .insert(userMemories)
    .values({
      userId: input.userId,
      content: input.content,
      embedding: input.embedding,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userMemories.userId,
      set: { content: input.content, embedding: input.embedding, updatedAt: now },
    })
    .returning();
  return mapUserMemory(row);
}

/** Forget one person entirely. Their pending notes cascade away with the row. */
export async function deleteUserMemory(db: DrizzleDb, userId: string): Promise<boolean> {
  const rows = await db
    .delete(userMemories)
    .where(eq(userMemories.userId, userId))
    .returning({ userId: userMemories.userId });
  return rows.length > 0;
}

/* -------------------------------------------------------- general document */

/** The single row's key. General memory is one document, like `settings`. */
const GENERAL_ID = "singleton";

/** The general-knowledge document, or null when nothing has been stored yet. */
export async function getGeneralMemory(db: DrizzleDb): Promise<GeneralMemory | null> {
  const [row] = await db.select().from(generalMemories).where(eq(generalMemories.id, GENERAL_ID));
  return row ? mapGeneralMemory(row) : null;
}

/** Write the general document (nightly merge, or an operator edit). */
export async function upsertGeneralMemory(
  db: DrizzleDb,
  content: string,
): Promise<GeneralMemory> {
  const [row] = await db
    .insert(generalMemories)
    .values({ id: GENERAL_ID, content, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: generalMemories.id,
      set: { content, updatedAt: new Date() },
    })
    .returning();
  return mapGeneralMemory(row);
}

/** Forget general knowledge entirely (operator "forget all"). */
export async function deleteGeneralMemory(db: DrizzleDb): Promise<boolean> {
  const rows = await db
    .delete(generalMemories)
    .where(eq(generalMemories.id, GENERAL_ID))
    .returning({ id: generalMemories.id });
  return rows.length > 0;
}

/* ---------------------------------------------------------------- searching */

/** Reciprocal-rank-fusion damping constant — the standard k=60 from the RRF paper. */
const RRF_K = 60;

/** A scored row from one half of the hybrid search. */
interface Ranked<T> {
  key: string;
  value: T;
  score: number;
}

/** Fuse ranked lists by reciprocal rank (see `searchChatSummaries` for the rationale). */
function fuseByRank<T>(lists: Array<Array<{ key: string; value: T }>>, limit: number): T[] {
  const fused = new Map<string, Ranked<T>>();
  for (const list of lists) {
    list.forEach((row, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(row.key);
      if (existing) existing.score += contribution;
      else fused.set(row.key, { key: row.key, value: row.value, score: contribution });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.value);
}

/**
 * Hybrid search over consolidated **user** memory: semantic (cosine over the
 * embedding) fused with lexical (Postgres full text) by reciprocal rank, the same
 * shape as the history-summary search.
 *
 * General knowledge is deliberately **not** searched (operator decision): it is
 * one document injected into every reply, so the model already has all of it in
 * context — searching it would spend a round-trip to hand back text the model can
 * already read. What remains worth searching is what is *not* injected: the
 * per-person documents of people who are not in this conversation.
 *
 * With no embedding configured this degrades to pure full text rather than
 * returning nothing.
 */
export async function searchMemories(
  db: DrizzleDb,
  params: { queryText: string; queryVector: number[] | null; limit: number },
): Promise<Array<{ scope: MemoryScope; userId: string | null; content: string }>> {
  // Pull a deeper pool from each half than we return, so a row ranked middling by
  // both halves can still win overall.
  const poolSize = Math.max(params.limit * 4, 20);
  const text = params.queryText.trim();

  const vectorHits = params.queryVector
    ? await Promise.all([
        db
          .select({ userId: userMemories.userId, content: userMemories.content })
          .from(userMemories)
          .where(isNotNull(userMemories.embedding))
          .orderBy(sql`${userMemories.embedding} <=> ${JSON.stringify(params.queryVector)}::vector`)
          .limit(poolSize),
      ])
    : [[]];

  const textHits = text
    ? await Promise.all([
        db
          .select({ userId: userMemories.userId, content: userMemories.content })
          .from(userMemories)
          .where(
            sql`to_tsvector('simple', ${userMemories.content}) @@ websearch_to_tsquery('simple', ${text})`,
          )
          .orderBy(
            sql`ts_rank(to_tsvector('simple', ${userMemories.content}), websearch_to_tsquery('simple', ${text})) desc`,
          )
          .limit(poolSize),
      ])
    : [[]];

  type Hit = { scope: MemoryScope; userId: string | null; content: string };
  const asUserHits = (rows: Array<{ userId: string; content: string }>) =>
    rows.map((r) => ({
      key: `user:${r.userId}`,
      value: { scope: "user" as const, userId: r.userId, content: r.content } satisfies Hit,
    }));

  return fuseByRank<Hit>([asUserHits(vectorHits[0]), asUserHits(textHits[0])], params.limit);
}

