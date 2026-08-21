import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { groupMembers, knownGroups, knownUsers, type KnownGroupRow } from "@/db/schema";

/**
 * Typed persistence for known Telegram groups and their membership. Pure data
 * access: no policy, no validation. Every function takes a {@link DrizzleDb} so
 * it runs against the pool or a test instance. Mirrors the known-users
 * repository.
 */

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

function mapRow(row: KnownGroupRow): KnownGroupRecord {
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
export async function listKnownGroups(db: DrizzleDb): Promise<KnownGroupSummaryRecord[]> {
  const rows = await db
    .select({
      chatId: knownGroups.chatId,
      title: knownGroups.title,
      type: knownGroups.type,
      notes: knownGroups.notes,
      language: knownGroups.language,
      firstSeenAt: knownGroups.firstSeenAt,
      updatedAt: knownGroups.updatedAt,
      memberCount: sql<number>`count(${groupMembers.userId})::int`,
    })
    .from(knownGroups)
    .leftJoin(groupMembers, eq(groupMembers.chatId, knownGroups.chatId))
    .groupBy(knownGroups.chatId)
    .orderBy(desc(knownGroups.updatedAt));
  return rows.map((row) => ({
    chatId: row.chatId,
    title: row.title,
    type: row.type,
    notes: row.notes,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    memberCount: row.memberCount,
  }));
}

/** One known group by id, or null. */
export async function getKnownGroup(
  db: DrizzleDb,
  chatId: string,
): Promise<KnownGroupRecord | null> {
  const row = await db.query.knownGroups.findFirst({ where: eq(knownGroups.chatId, chatId) });
  return row ? mapRow(row) : null;
}

/**
 * Upsert the Telegram profile of a group the bot is active in. Refreshes the
 * mutable profile fields but leaves operator-curated `notes` (and `first_seen_at`)
 * untouched.
 */
export async function upsertKnownGroup(
  db: DrizzleDb,
  profile: TelegramGroupProfile,
): Promise<void> {
  const now = new Date();
  await db
    .insert(knownGroups)
    .values({
      chatId: profile.chatId,
      title: profile.title,
      type: profile.type,
      firstSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: knownGroups.chatId,
      set: {
        title: profile.title,
        type: profile.type,
        updatedAt: now,
      },
    });
}

/** Replace a group's operator notes. Returns the updated record, or null if unknown. */
export async function setKnownGroupNotes(
  db: DrizzleDb,
  chatId: string,
  notes: string | null,
): Promise<KnownGroupRecord | null> {
  const [row] = await db
    .update(knownGroups)
    .set({ notes, updatedAt: new Date() })
    .where(eq(knownGroups.chatId, chatId))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Set (or clear, with null) a group's operator-configured reply language.
 * Returns the updated record, or null if the group is unknown.
 */
export async function setKnownGroupLanguage(
  db: DrizzleDb,
  chatId: string,
  language: string | null,
): Promise<KnownGroupRecord | null> {
  const [row] = await db
    .update(knownGroups)
    .set({ language, updatedAt: new Date() })
    .where(eq(knownGroups.chatId, chatId))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Record that a user was seen in a group: insert the membership (or refresh
 * `last_seen_at` on conflict). Assumes the referenced known-group and known-user
 * rows already exist (the caller upserts both first).
 */
export async function recordGroupMembership(
  db: DrizzleDb,
  chatId: string,
  userId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(groupMembers)
    .values({ chatId, userId, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [groupMembers.chatId, groupMembers.userId],
      set: { lastSeenAt: now },
    });
}

/** Whether a user is already recorded as a member of a group. */
export async function groupMembershipExists(
  db: DrizzleDb,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.query.groupMembers.findFirst({
    where: and(eq(groupMembers.chatId, chatId), eq(groupMembers.userId, userId)),
  });
  return row != null;
}

/**
 * Every (group, member) pair, most-recently-active first. The rosters of all
 * groups at once, for a dashboard view that already holds the user profiles and
 * needs only to know who belongs where — one query instead of one per group.
 */
export async function listGroupMemberships(
  db: DrizzleDb,
): Promise<{ chatId: string; userId: string }[]> {
  return db
    .select({ chatId: groupMembers.chatId, userId: groupMembers.userId })
    .from(groupMembers)
    .orderBy(desc(groupMembers.lastSeenAt));
}

/**
 * Members of a group (known-user profiles joined with membership timestamps),
 * most-recently-active first. `limit` bounds the roster so context injection and
 * the dashboard stay bounded for busy groups.
 */
export async function getGroupMembers(
  db: DrizzleDb,
  chatId: string,
  limit = 200,
): Promise<GroupMemberRecord[]> {
  const rows = await db
    .select({
      userId: knownUsers.userId,
      username: knownUsers.username,
      firstName: knownUsers.firstName,
      lastName: knownUsers.lastName,
      aliases: knownUsers.aliases,
      firstSeenAt: groupMembers.firstSeenAt,
      lastSeenAt: groupMembers.lastSeenAt,
    })
    .from(groupMembers)
    .innerJoin(knownUsers, eq(knownUsers.userId, groupMembers.userId))
    .where(eq(groupMembers.chatId, chatId))
    .orderBy(desc(groupMembers.lastSeenAt))
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
