import "server-only";

import { eq, inArray } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { knownUsers, type KnownUserRow } from "@/db/schema";

/**
 * Typed persistence for known Telegram users. Pure data access: no policy, no
 * validation. Every function takes a {@link DrizzleDb} so it runs against the
 * pool or a test instance.
 */

/** A known user as stored. */
export interface KnownUserRecord {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  aliases: string[];
  /** Operator-configured reply language for this user's DM, or null (default). */
  language: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** Telegram profile fields captured on each message (never includes aliases). */
export interface TelegramUserProfile {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

function mapRow(row: KnownUserRow): KnownUserRecord {
  return {
    userId: row.userId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    aliases: row.aliases,
    language: row.language,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All known users, most-recently-seen first. */
export async function listKnownUsers(db: DrizzleDb): Promise<KnownUserRecord[]> {
  const rows = await db.query.knownUsers.findMany({ orderBy: (u, { desc }) => [desc(u.updatedAt)] });
  return rows.map(mapRow);
}

/** One known user by id, or null. */
export async function getKnownUser(db: DrizzleDb, userId: string): Promise<KnownUserRecord | null> {
  const row = await db.query.knownUsers.findFirst({ where: eq(knownUsers.userId, userId) });
  return row ? mapRow(row) : null;
}

/** Many known users by id (for label resolution). */
export async function getKnownUsersByIds(
  db: DrizzleDb,
  userIds: string[],
): Promise<KnownUserRecord[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await db.query.knownUsers.findMany({ where: inArray(knownUsers.userId, unique) });
  return rows.map(mapRow);
}

/**
 * Upsert the Telegram profile of a user who messaged the bot. Refreshes the
 * mutable profile fields but leaves operator-curated `aliases` (and `first_seen_at`)
 * untouched.
 */
export async function upsertKnownUser(db: DrizzleDb, profile: TelegramUserProfile): Promise<void> {
  const now = new Date();
  await db
    .insert(knownUsers)
    .values({
      userId: profile.userId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      firstSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: knownUsers.userId,
      set: {
        username: profile.username,
        firstName: profile.firstName,
        lastName: profile.lastName,
        updatedAt: now,
      },
    });
}

/** Replace a user's alias list. Returns the updated record, or null if unknown. */
export async function setKnownUserAliases(
  db: DrizzleDb,
  userId: string,
  aliases: string[],
): Promise<KnownUserRecord | null> {
  const [row] = await db
    .update(knownUsers)
    .set({ aliases, updatedAt: new Date() })
    .where(eq(knownUsers.userId, userId))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Set (or clear, with null) a user's operator-configured DM reply language.
 * Returns the updated record, or null if the user is unknown.
 */
export async function setKnownUserLanguage(
  db: DrizzleDb,
  userId: string,
  language: string | null,
): Promise<KnownUserRecord | null> {
  const [row] = await db
    .update(knownUsers)
    .set({ language, updatedAt: new Date() })
    .where(eq(knownUsers.userId, userId))
    .returning();
  return row ? mapRow(row) : null;
}
