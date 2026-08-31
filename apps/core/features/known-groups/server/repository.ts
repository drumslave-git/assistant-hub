import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { sourceChatMembers, sourceChats, sourceUsers } from "../../../store/schema";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * Typed persistence for known Telegram groups and their membership — since
 * the Phase 10 cutover an adapter over the source store's `source_chats` /
 * `source_chat_members` rows (`source = 'tg'`), which the ingest maintains
 * from live traffic. The record shapes and the function surface are
 * unchanged from the v1 shadow this replaces. A "group" is a tg chat row
 * whose type is not a direct chat (direct chats are not stored as chat rows
 * for tg — only groups get one).
 */

const SOURCE = "tg" as const;

/** A known group as stored. */
export interface KnownGroupRecord {
  chatId: string;
  title: string | null;
  type: string | null;
  notes: string | null;
  /** Operator-configured reply language for this group, or null (default). */
  language: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** A known group plus its member count, for the groups list. */
export interface KnownGroupSummaryRecord extends KnownGroupRecord {
  memberCount: number;
}

/** Telegram group fields captured on each message (never includes notes). */
export interface TelegramGroupProfile {
  chatId: string;
  title: string | null;
  type: string | null;
}

/** A group member: the known-user profile plus when they were seen in the group. */
export interface GroupMemberRecord {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

type ChatRow = typeof sourceChats.$inferSelect;

function mapRow(row: ChatRow): KnownGroupRecord {
  return {
    chatId: row.chatId,
    title: row.title,
    type: row.type,
    notes: row.notes,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All known groups (with member counts), most-recently-seen first. */
export async function listKnownGroups(
  db: StoreDb = getStoreDb(),
): Promise<KnownGroupSummaryRecord[]> {
  const rows = await db
    .select({
      chat: sourceChats,
      memberCount: sql<number>`count(${sourceChatMembers.userId})::int`,
    })
    .from(sourceChats)
    .leftJoin(
      sourceChatMembers,
      and(
        eq(sourceChatMembers.source, sourceChats.source),
        eq(sourceChatMembers.chatId, sourceChats.chatId),
      ),
    )
    .where(eq(sourceChats.source, SOURCE))
    .groupBy(sourceChats.source, sourceChats.chatId)
    .orderBy(desc(sourceChats.updatedAt));
  return rows.map((row) => ({ ...mapRow(row.chat), memberCount: row.memberCount }));
}

/** One known group by id, or null. */
export async function getKnownGroup(
  db: StoreDb | undefined,
  chatId: string,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .select()
    .from(sourceChats)
    .where(and(eq(sourceChats.source, SOURCE), eq(sourceChats.chatId, chatId)))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Upsert the Telegram profile of a group the bot is active in. Refreshes the
 * mutable profile fields but leaves operator-curated `notes` (and
 * `first_seen_at`) untouched. The live path is the ingest's own upsert; this
 * stays for tests and curated flows.
 */
export async function upsertKnownGroup(
  db: StoreDb | undefined,
  profile: TelegramGroupProfile,
): Promise<void> {
  const handle = db ?? getStoreDb();
  await handle
    .insert(sourceChats)
    .values({
      source: SOURCE,
      chatId: profile.chatId,
      title: profile.title,
      type: profile.type ?? "group",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [sourceChats.source, sourceChats.chatId],
      set: { title: profile.title, type: profile.type ?? "group", updatedAt: new Date() },
    });
}

/** Replace a group's operator notes. Returns the updated record, or null if unknown. */
export async function setKnownGroupNotes(
  db: StoreDb | undefined,
  chatId: string,
  notes: string | null,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .update(sourceChats)
    .set({ notes, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, SOURCE), eq(sourceChats.chatId, chatId)))
    .returning();
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Set (or clear, with null) a group's operator-configured reply language.
 * Returns the updated record, or null if the group is unknown.
 */
export async function setKnownGroupLanguage(
  db: StoreDb | undefined,
  chatId: string,
  language: string | null,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .update(sourceChats)
    .set({ language, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, SOURCE), eq(sourceChats.chatId, chatId)))
    .returning();
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Record that a user was seen in a group: insert the membership (or refresh
 * `last_seen_at` on conflict). Assumes the referenced chat and user rows
 * already exist (the caller upserts both first).
 */
export async function recordGroupMembership(
  db: StoreDb | undefined,
  chatId: string,
  userId: string,
): Promise<void> {
  await (db ?? getStoreDb())
    .insert(sourceChatMembers)
    .values({ source: SOURCE, chatId, userId })
    .onConflictDoUpdate({
      target: [sourceChatMembers.source, sourceChatMembers.chatId, sourceChatMembers.userId],
      set: { lastSeenAt: new Date() },
    });
}

/** Whether a user is already recorded as a member of a group. */
export async function groupMembershipExists(
  db: StoreDb | undefined,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const rows = await (db ?? getStoreDb())
    .select({ userId: sourceChatMembers.userId })
    .from(sourceChatMembers)
    .where(
      and(
        eq(sourceChatMembers.source, SOURCE),
        eq(sourceChatMembers.chatId, chatId),
        eq(sourceChatMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Every (group, member) pair, most-recently-active first. The rosters of all
 * groups at once, for a dashboard view that already holds the user profiles
 * and needs only to know who belongs where — one query instead of one per
 * group.
 */
export async function listGroupMemberships(
  db: StoreDb = getStoreDb(),
): Promise<{ chatId: string; userId: string }[]> {
  return db
    .select({ chatId: sourceChatMembers.chatId, userId: sourceChatMembers.userId })
    .from(sourceChatMembers)
    .where(eq(sourceChatMembers.source, SOURCE))
    .orderBy(desc(sourceChatMembers.lastSeenAt));
}

/**
 * Members of a group (user profiles joined with membership timestamps),
 * most-recently-active first. `limit` bounds the roster so context injection
 * and the dashboard stay bounded for busy groups.
 */
export async function getGroupMembers(
  db: StoreDb | undefined,
  chatId: string,
  limit = 200,
): Promise<GroupMemberRecord[]> {
  const rows = await (db ?? getStoreDb())
    .select({
      userId: sourceUsers.userId,
      username: sourceUsers.username,
      firstName: sourceUsers.firstName,
      lastName: sourceUsers.lastName,
      aliases: sourceUsers.aliases,
      firstSeenAt: sourceChatMembers.firstSeenAt,
      lastSeenAt: sourceChatMembers.lastSeenAt,
    })
    .from(sourceChatMembers)
    .innerJoin(
      sourceUsers,
      and(
        eq(sourceUsers.source, sourceChatMembers.source),
        eq(sourceUsers.userId, sourceChatMembers.userId),
      ),
    )
    .where(and(eq(sourceChatMembers.source, SOURCE), eq(sourceChatMembers.chatId, chatId)))
    .orderBy(desc(sourceChatMembers.lastSeenAt))
    .limit(limit);
  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    aliases: row.aliases,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}
