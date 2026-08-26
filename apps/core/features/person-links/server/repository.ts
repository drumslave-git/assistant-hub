import "server-only";

import { asc, eq, inArray } from "drizzle-orm";

import { personLinkMembers, personLinks } from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

/**
 * Typed persistence for person links, over the v2 core store. Pure data
 * access: no policy, no validation, no trace recording (the service owns
 * those). Every function takes a {@link StoreDb} so it runs against the
 * process pool or a test instance.
 */

/** One stored identity of a link. */
export interface PersonLinkMemberRecord {
  userRef: string;
  addedAt: string;
}

/** A person link as stored, with its identities. */
export interface PersonLinkRecord {
  id: string;
  note: string | null;
  members: PersonLinkMemberRecord[];
  createdAt: string;
  updatedAt: string;
}

type LinkRow = typeof personLinks.$inferSelect;
type MemberRow = typeof personLinkMembers.$inferSelect;

function mapRow(row: LinkRow, members: MemberRow[]): PersonLinkRecord {
  return {
    id: row.id,
    note: row.note,
    members: members.map((member) => ({
      userRef: member.userRef,
      addedAt: member.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Members of a set of links, grouped by link id (oldest membership first). */
async function membersByLink(
  db: StoreDb,
  linkIds: string[],
): Promise<Map<string, MemberRow[]>> {
  const byLink = new Map<string, MemberRow[]>();
  if (linkIds.length === 0) return byLink;
  const rows = await db
    .select()
    .from(personLinkMembers)
    .where(inArray(personLinkMembers.linkId, linkIds))
    .orderBy(asc(personLinkMembers.createdAt));
  for (const row of rows) {
    const list = byLink.get(row.linkId);
    if (list) list.push(row);
    else byLink.set(row.linkId, [row]);
  }
  return byLink;
}

/** Every person link with its identities, oldest first. */
export async function listPersonLinks(db: StoreDb): Promise<PersonLinkRecord[]> {
  const rows = await db.select().from(personLinks).orderBy(asc(personLinks.createdAt));
  const byLink = await membersByLink(db, rows.map((row) => row.id));
  return rows.map((row) => mapRow(row, byLink.get(row.id) ?? []));
}

/** One link by id, or null. */
export async function getPersonLink(db: StoreDb, id: string): Promise<PersonLinkRecord | null> {
  const rows = await db.select().from(personLinks).where(eq(personLinks.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const byLink = await membersByLink(db, [row.id]);
  return mapRow(row, byLink.get(row.id) ?? []);
}

/**
 * Which link each of these refs already belongs to. The lookup behind both
 * the conflict check (a ref belongs to at most one link) and memory
 * resolution — refs with no link are simply absent from the map.
 */
export async function findLinksForRefs(
  db: StoreDb,
  userRefs: string[],
): Promise<Map<string, string>> {
  if (userRefs.length === 0) return new Map();
  const rows = await db
    .select()
    .from(personLinkMembers)
    .where(inArray(personLinkMembers.userRef, userRefs));
  return new Map(rows.map((row) => [row.userRef, row.linkId]));
}

/** Every identity of the given links, keyed by link id. */
export async function listMembersOfLinks(
  db: StoreDb,
  linkIds: string[],
): Promise<Map<string, string[]>> {
  const byLink = await membersByLink(db, linkIds);
  return new Map([...byLink].map(([id, rows]) => [id, rows.map((row) => row.userRef)]));
}

/** Insert a link and its identities atomically. */
export async function insertPersonLink(
  db: StoreDb,
  input: { id: string; note: string | null; members: string[] },
): Promise<PersonLinkRecord> {
  await db.transaction(async (tx) => {
    await tx.insert(personLinks).values({ id: input.id, note: input.note });
    await tx
      .insert(personLinkMembers)
      .values(input.members.map((userRef) => ({ linkId: input.id, userRef })));
  });
  const record = await getPersonLink(db, input.id);
  if (!record) throw new Error(`person link ${input.id} vanished after insert`);
  return record;
}

/** Set (or clear) a link's note. Null when the link is unknown. */
export async function updatePersonLinkNote(
  db: StoreDb,
  id: string,
  note: string | null,
): Promise<PersonLinkRecord | null> {
  const rows = await db
    .update(personLinks)
    .set({ note, updatedAt: new Date() })
    .where(eq(personLinks.id, id))
    .returning();
  if (rows.length === 0) return null;
  return getPersonLink(db, id);
}

/**
 * Replace a link's identities atomically. Membership rows carry only their
 * ref and creation time, so a full replacement is the simplest write that
 * cannot leave a half-updated link; identities that survive are re-added,
 * which resets their "added" time — the link's own timestamps are what the
 * dashboard shows.
 */
export async function replacePersonLinkMembers(
  db: StoreDb,
  id: string,
  members: string[],
): Promise<PersonLinkRecord | null> {
  const exists = await db.select().from(personLinks).where(eq(personLinks.id, id)).limit(1);
  if (exists.length === 0) return null;
  await db.transaction(async (tx) => {
    await tx.delete(personLinkMembers).where(eq(personLinkMembers.linkId, id));
    await tx.insert(personLinkMembers).values(members.map((userRef) => ({ linkId: id, userRef })));
    await tx.update(personLinks).set({ updatedAt: new Date() }).where(eq(personLinks.id, id));
  });
  return getPersonLink(db, id);
}

/** Delete a link (its memberships cascade). False when it did not exist. */
export async function deletePersonLink(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db
    .delete(personLinks)
    .where(eq(personLinks.id, id))
    .returning({ id: personLinks.id });
  return rows.length > 0;
}
