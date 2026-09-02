import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";
import { and, desc, eq, sql } from "drizzle-orm";

import { sourceChatMembers, sourceChats, sourceUsers } from "../../../store/schema";
import { listSourceChatSenderIds } from "@/server/source-store/repository";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * Typed persistence for known groups and their membership — an adapter over
 * the source store's `source_chats` / `source_chat_members` rows, which the
 * ingest maintains from live traffic. Every read and write names the source
 * whose chats it touches. A "group" is a chat the transport reported as
 * not direct: the ingest stores a chat row for those only, so a chat row's
 * existence IS the group/direct distinction — no platform's id shape is
 * consulted.
 */

/** A known group as stored. */
export interface KnownGroupRecord {
  /** The transport this chat lives on. */
  source: SourceId;
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

/** Group fields a transport captures on each message (never includes notes). */
export interface SourceGroupProfile {
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
    source: row.source,
    chatId: row.chatId,
    title: row.title,
    type: row.type,
    notes: row.notes,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All of one source's known groups (with member counts), most-recently-seen first. */
export async function listKnownGroups(
  db: StoreDb | undefined,
  source: SourceId,
): Promise<KnownGroupSummaryRecord[]> {
  const rows = await (db ?? getStoreDb())
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
    .where(eq(sourceChats.source, source))
    .groupBy(sourceChats.source, sourceChats.chatId)
    .orderBy(desc(sourceChats.updatedAt));
  return rows.map((row) => ({ ...mapRow(row.chat), memberCount: row.memberCount }));
}

/** One known group by id, or null (a direct chat has no row). */
export async function getKnownGroup(
  db: StoreDb | undefined,
  source: SourceId,
  chatId: string,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .select()
    .from(sourceChats)
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Whether a chat is a group: the transport reported it as one, so the ingest stored a row. */
export async function isGroupChat(
  db: StoreDb | undefined,
  source: SourceId,
  chatId: string,
): Promise<boolean> {
  return (await getKnownGroup(db, source, chatId)) !== null;
}

/**
 * The people who take part in a chat: a group's roster, or — for a direct
 * chat, which has no roster — whoever has messaged in it. Both are "people
 * who have spoken here", which is what every chat-scoped lookup (a name
 * reference, a task's targets) is allowed to reach.
 */
export async function listChatParticipantIds(
  db: StoreDb | undefined,
  source: SourceId,
  chatId: string,
): Promise<string[]> {
  if (await isGroupChat(db, source, chatId)) {
    return (await getGroupMembers(db, source, chatId)).map((member) => member.userId);
  }
  return listSourceChatSenderIds(source, chatId, db);
}

/**
 * Upsert the profile of a group the bot is active in. Refreshes the mutable
 * profile fields but leaves operator-curated `notes` (and `first_seen_at`)
 * untouched. The live path is the ingest's own upsert; this stays for tests
 * and curated flows.
 */
export async function upsertKnownGroup(
  db: StoreDb | undefined,
  source: SourceId,
  profile: SourceGroupProfile,
): Promise<void> {
  const handle = db ?? getStoreDb();
  await handle
    .insert(sourceChats)
    .values({
      source,
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
  source: SourceId,
  chatId: string,
  notes: string | null,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .update(sourceChats)
    .set({ notes, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
    .returning();
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Set (or clear, with null) a group's operator-configured reply language.
 * Returns the updated record, or null if the group is unknown.
 */
export async function setKnownGroupLanguage(
  db: StoreDb | undefined,
  source: SourceId,
  chatId: string,
  language: string | null,
): Promise<KnownGroupRecord | null> {
  const rows = await (db ?? getStoreDb())
    .update(sourceChats)
    .set({ language, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
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
  source: SourceId,
  chatId: string,
  userId: string,
): Promise<void> {
  await (db ?? getStoreDb())
    .insert(sourceChatMembers)
    .values({ source, chatId, userId })
    .onConflictDoUpdate({
      target: [sourceChatMembers.source, sourceChatMembers.chatId, sourceChatMembers.userId],
      set: { lastSeenAt: new Date() },
    });
}

/** Whether a user is already recorded as a member of a group. */
export async function groupMembershipExists(
  db: StoreDb | undefined,
  source: SourceId,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const rows = await (db ?? getStoreDb())
    .select({ userId: sourceChatMembers.userId })
    .from(sourceChatMembers)
    .where(
      and(
        eq(sourceChatMembers.source, source),
        eq(sourceChatMembers.chatId, chatId),
        eq(sourceChatMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Every (group, member) pair of one source, most-recently-active first. The
 * rosters of all groups at once, for a dashboard view that already holds the
 * user profiles and needs only to know who belongs where — one query instead
 * of one per group.
 */
export async function listGroupMemberships(
  db: StoreDb | undefined,
  source: SourceId,
): Promise<{ chatId: string; userId: string }[]> {
  return (db ?? getStoreDb())
    .select({ chatId: sourceChatMembers.chatId, userId: sourceChatMembers.userId })
    .from(sourceChatMembers)
    .where(eq(sourceChatMembers.source, source))
    .orderBy(desc(sourceChatMembers.lastSeenAt));
}

/**
 * Members of a group (user profiles joined with membership timestamps),
 * most-recently-active first. `limit` bounds the roster so context injection
 * and the dashboard stay bounded for busy groups.
 */
export async function getGroupMembers(
  db: StoreDb | undefined,
  source: SourceId,
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
    .where(and(eq(sourceChatMembers.source, source), eq(sourceChatMembers.chatId, chatId)))
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
