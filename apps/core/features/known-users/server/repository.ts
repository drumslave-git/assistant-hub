import "server-only";

import type { StoreDb } from "@/server/store/db";
import {
  getSourceUserById,
  getSourceUsersByIds,
  listSourceUsers,
  updateSourceUserAliases,
  updateSourceUserLanguage,
  upsertSourceUser,
  type SourceUserRow,
} from "@/server/source-store/repository";

/**
 * Typed persistence for known Telegram users — since the Phase 10 cutover an
 * adapter over the source store's `source_users` rows (`source = 'tg'`),
 * which the ingest maintains from live traffic. The record shape and the
 * function surface are unchanged from the v1 shadow this replaces, so the
 * label/roster/alias consumers across the brain did not have to move.
 */

const SOURCE = "tg" as const;

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

function mapRow(row: SourceUserRow): KnownUserRecord {
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
export async function listKnownUsers(db?: StoreDb): Promise<KnownUserRecord[]> {
  const rows = await listSourceUsers(SOURCE, db);
  return rows.map(mapRow).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One known user by id, or null. */
export async function getKnownUser(
  db: StoreDb | undefined,
  userId: string,
): Promise<KnownUserRecord | null> {
  const row = await getSourceUserById(SOURCE, userId, db);
  return row ? mapRow(row) : null;
}

/** Many known users by id (for label resolution). */
export async function getKnownUsersByIds(
  db: StoreDb | undefined,
  userIds: string[],
): Promise<KnownUserRecord[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await getSourceUsersByIds(SOURCE, unique, db);
  return rows.map(mapRow);
}

/**
 * Upsert the Telegram profile of a user who messaged the bot. Refreshes the
 * mutable profile fields but leaves operator-curated `aliases` (and
 * `first_seen_at`) untouched. The live path is the ingest's own upsert; this
 * stays for the curated-edit flows and tests.
 */
export async function upsertKnownUser(
  db: StoreDb | undefined,
  profile: TelegramUserProfile,
): Promise<void> {
  await upsertSourceUser({ source: SOURCE, ...profile }, db);
}

/** Replace a user's alias list. Returns the updated record, or null if unknown. */
export async function setKnownUserAliases(
  db: StoreDb | undefined,
  userId: string,
  aliases: string[],
): Promise<KnownUserRecord | null> {
  const row = await updateSourceUserAliases(SOURCE, userId, aliases, db);
  return row ? mapRow(row) : null;
}

/**
 * Set (or clear, with null) a user's operator-configured DM reply language.
 * Returns the updated record, or null if the user is unknown.
 */
export async function setKnownUserLanguage(
  db: StoreDb | undefined,
  userId: string,
  language: string | null,
): Promise<KnownUserRecord | null> {
  const row = await updateSourceUserLanguage(SOURCE, userId, language, db);
  return row ? mapRow(row) : null;
}
