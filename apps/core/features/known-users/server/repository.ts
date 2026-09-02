import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";

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
 * Typed persistence for known users — an adapter over the source store's
 * `source_users` rows, which the ingest maintains from live traffic. Every
 * read and write names the source whose people it touches: a user id is
 * only meaningful together with the transport that issued it, so nothing
 * here assumes a platform. The record shape and the function surface are
 * otherwise unchanged from the v1 shadow this replaces, so the
 * label/roster/alias consumers across the brain did not have to move.
 */

/** A known user as stored. */
export interface KnownUserRecord {
  /** The transport this person is known through. */
  source: SourceId;
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

/** Profile fields a transport captures on each message (never includes aliases). */
export interface SourceUserProfile {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

function mapRow(row: SourceUserRow): KnownUserRecord {
  return {
    source: row.source,
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

/** All of one source's known users, most-recently-seen first. */
export async function listKnownUsers(
  db: StoreDb | undefined,
  source: SourceId,
): Promise<KnownUserRecord[]> {
  const rows = await listSourceUsers(source, db);
  return rows.map(mapRow).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One known user by id, or null. */
export async function getKnownUser(
  db: StoreDb | undefined,
  source: SourceId,
  userId: string,
): Promise<KnownUserRecord | null> {
  const row = await getSourceUserById(source, userId, db);
  return row ? mapRow(row) : null;
}

/** Many known users by id (for label resolution). */
export async function getKnownUsersByIds(
  db: StoreDb | undefined,
  source: SourceId,
  userIds: readonly string[],
): Promise<KnownUserRecord[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await getSourceUsersByIds(source, unique, db);
  return rows.map(mapRow);
}

/**
 * Upsert the profile of a user who messaged the bot. Refreshes the mutable
 * profile fields but leaves operator-curated `aliases` (and `first_seen_at`)
 * untouched. The live path is the ingest's own upsert; this stays for the
 * curated-edit flows and tests.
 */
export async function upsertKnownUser(
  db: StoreDb | undefined,
  source: SourceId,
  profile: SourceUserProfile,
): Promise<void> {
  await upsertSourceUser({ source, ...profile }, db);
}

/** Replace a user's alias list. Returns the updated record, or null if unknown. */
export async function setKnownUserAliases(
  db: StoreDb | undefined,
  source: SourceId,
  userId: string,
  aliases: string[],
): Promise<KnownUserRecord | null> {
  const row = await updateSourceUserAliases(source, userId, aliases, db);
  return row ? mapRow(row) : null;
}

/**
 * Set (or clear, with null) a user's operator-configured DM reply language.
 * Returns the updated record, or null if the user is unknown.
 */
export async function setKnownUserLanguage(
  db: StoreDb | undefined,
  source: SourceId,
  userId: string,
  language: string | null,
): Promise<KnownUserRecord | null> {
  const row = await updateSourceUserLanguage(source, userId, language, db);
  return row ? mapRow(row) : null;
}
