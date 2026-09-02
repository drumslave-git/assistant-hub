import "server-only";

import { randomUUID } from "node:crypto";

import { parseScopedRef } from "@assistant-hub-swarm/contracts";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getEnv } from "@/server/env";
import { publishEvent } from "@/server/realtime/hub";
import { listDirectoryUsers, sourceLabelOf, sourceLabels } from "@/server/source/directory";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import {
  deletePersonLink,
  findLinksForRefs,
  getPersonLink,
  insertPersonLink,
  listMembersOfLinks,
  listPersonLinks,
  replacePersonLinkMembers,
  updatePersonLinkNote,
  type PersonLinkRecord,
} from "./repository";
import type { CreatePersonLink, PersonLink, UpdatePersonLink } from "./schema";

/**
 * Person-links domain service — the boundary Route Handlers, Server
 * Components, and the memory reader call. Owns the one invariant the store
 * cannot express legibly (an identity belongs to at most one link, reported
 * as a conflict naming the link that already holds it), label resolution
 * against the aggregated directory, trace recording for every mutation, and
 * live-refresh publishing.
 */

const FEATURE = FEATURES["person-links"];

/**
 * Attach display labels to a link's identities. Labels come from the
 * aggregated directory, so a linked person reads the same here as on the
 * directory page; a ref no source currently knows keeps a null label and is
 * rendered as the bare ref rather than as an invented name.
 */
function toClient(
  records: PersonLinkRecord[],
  labels: Map<string, string>,
  sourceNames: Map<string, string>,
): PersonLink[] {
  return records.map((record) => ({
    id: record.id,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    members: record.members.map((member) => {
      const { source } = parseScopedRef(member.userRef);
      return {
        userRef: member.userRef,
        source,
        sourceLabel: sourceLabelOf(sourceNames, source),
        label: labels.get(member.userRef) ?? null,
        addedAt: member.addedAt,
      };
    }),
  }));
}

/** Directory labels keyed by scoped ref, for the listing's members. */
async function directoryLabels(): Promise<Map<string, string>> {
  const { entries } = await listDirectoryUsers();
  return new Map(entries.map((entry) => [entry.ref, entry.label]));
}

/** Every person link, oldest first, with its identities resolved. */
export async function getPersonLinks(db: StoreDb = getStoreDb()): Promise<PersonLink[]> {
  const [records, labels] = await Promise.all([listPersonLinks(db), directoryLabels()]);
  return toClient(records, labels, await sourceLabels());
}

/** One link, resolved. Throws when it is gone. */
async function readOne(id: string, db: StoreDb): Promise<PersonLink> {
  const record = await getPersonLink(db, id);
  if (!record) throw ApiError.notFound("Unknown person link");
  return toClient([record], await directoryLabels(), await sourceLabels())[0];
}

/**
 * Refuse identities already claimed by another link. The store's unique
 * index would reject the write anyway, but as an opaque constraint error —
 * the operator needs to be told which identity is already spoken for.
 */
async function assertUnclaimed(
  db: StoreDb,
  members: string[],
  exceptLinkId: string | null,
): Promise<void> {
  const claimed = await findLinksForRefs(db, members);
  for (const [userRef, linkId] of claimed) {
    if (linkId === exceptLinkId) continue;
    throw ApiError.conflict(`${userRef} already belongs to another person link`);
  }
}

/** Join identities into one person, recorded as a trace. */
export async function createLink(
  input: CreatePersonLink,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<PersonLink> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "create-link",
      trigger,
      inputSummary: input.members.join(" = "),
    },
    async (trace) => {
      await trace.event({ type: "input", message: "link requested", data: input });
      await assertUnclaimed(db, input.members, null);
      const record = await insertPersonLink(db, {
        id: randomUUID(),
        note: input.note || null,
        members: input.members,
      });
      await trace.event({ type: "db", message: "link created", data: { id: record.id } });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${record.members.length} identities linked`,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      return readOne(record.id, db);
    },
  );
}

/** Edit a link's note or its identity list, recorded as a trace. */
export async function editLink(
  id: string,
  input: UpdatePersonLink,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<PersonLink> {
  const isNote = "note" in input;
  return withTrace(
    {
      feature: FEATURE.id,
      action: isNote ? "update-note" : "update-members",
      trigger,
      inputSummary: `link ${id}`,
    },
    async (trace) => {
      await trace.event({ type: "input", message: "link update", data: input });
      if (!isNote) await assertUnclaimed(db, input.members, id);
      const record = isNote
        ? await updatePersonLinkNote(db, id, input.note)
        : await replacePersonLinkMembers(db, id, input.members);
      if (!record) throw ApiError.notFound("Unknown person link");
      await trace.event({ type: "db", message: isNote ? "note updated" : "identities replaced" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: isNote
          ? input.note
            ? "note set"
            : "note cleared"
          : `${record.members.length} identities linked`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
      return readOne(id, db);
    },
  );
}

/** Break a person apart again, recorded as a trace. */
export async function removeLink(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete-link", trigger, inputSummary: `link ${id}` },
    async (trace) => {
      const record = await getPersonLink(db, id);
      if (!record) throw ApiError.notFound("Unknown person link");
      await trace.event({
        type: "input",
        message: "link removal",
        data: { id, members: record.members.map((member) => member.userRef) },
      });
      await deletePersonLink(db, id);
      await trace.event({ type: "db", message: "link deleted" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${record.members.length} identities unlinked`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
    },
  );
}

/* -------------------------------------------------------------- resolution */

/**
 * Server-only: expand identities to the people they belong to. For each ref
 * asked about, the full set of refs the operator has declared to be the same
 * human — always including the ref itself, so a caller can use the result
 * unconditionally.
 *
 * This is the read behind "memory follows the person": a fact stored under
 * one of someone's identities is theirs whichever identity they reach the bot
 * by. It runs on the message path, so it stays a pair of indexed lookups and
 * never touches the directory.
 *
 * Best-effort by design: a deployment without the v2 store yet (the
 * transitional `DATABASE_URL` is optional until the Phase 6 cutover),
 * or a store that cannot be read, resolves every ref to itself — memory then
 * behaves exactly as it did before links existed, rather than failing a
 * reply. Writes are not forgiving this way.
 */
export async function resolveLinkedRefs(
  userRefs: readonly string[],
  db?: StoreDb,
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(userRefs.filter(Boolean))];
  const identity = new Map(wanted.map((ref) => [ref, [ref]]));
  if (wanted.length === 0) return identity;
  if (!db && !getEnv().DATABASE_URL) return identity;

  try {
    const handle = db ?? getStoreDb();
    const linkOf = await findLinksForRefs(handle, wanted);
    if (linkOf.size === 0) return identity;
    const membersOf = await listMembersOfLinks(handle, [...new Set(linkOf.values())]);
    for (const [ref, linkId] of linkOf) {
      const members = membersOf.get(linkId);
      if (!members || members.length === 0) continue;
      // The asked-for ref leads its own group: callers attribute the merged
      // result to the identity that is actually present in the conversation.
      identity.set(ref, [ref, ...members.filter((member) => member !== ref)]);
    }
    return identity;
  } catch (err) {
    console.warn(
      "Person links unreadable — identities stay separate:",
      err instanceof Error ? err.message : String(err),
    );
    return identity;
  }
}
