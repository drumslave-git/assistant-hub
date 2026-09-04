import "server-only";

import { scopedRef, tryParseScopedRef } from "@assistant-hub-swarm/contracts";

import { getUserMemoriesFor } from "@/features/memory/server/repository";
import { forgetUser } from "@/features/memory/server/service";
import {
  deletePersonLink,
  findLinksForRefs,
  listMembersOfLinks,
  replacePersonLinkMembers,
} from "@/features/person-links/server/repository";
import { resolveLinkedRefs } from "@/features/person-links/server/service";
import { listDirectoryUsers, sourceLabelOf, sourceLabels } from "@/server/source/directory";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getAccountById, updateAccount } from "@/server/auth/accounts";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { publishEvent } from "@/server/realtime/hub";
import { withTrace } from "@/server/trace";

/**
 * The profile — an account's own surface (redesign Phase 8): who it is, the
 * platform identities linked to it, and the memory held about it. Every
 * read and write here is scoped to the ACTING account; the admin pages stay
 * the global views. Deleting a memory document goes through the memory
 * service's own traced delete.
 */

const FEATURE = FEATURES.accounts;

/** One identity attached to the profile's person, via the link graph. */
export interface ProfileIdentity {
  ref: string;
  source: string;
  sourceLabel: string;
  /** Directory label, or null when no source currently knows the ref. */
  label: string | null;
  /** True for the account's own web-chat identity. */
  self: boolean;
}

/** A memory document about one of the profile's identities. */
export interface ProfileMemoryDoc {
  /** The scoped ref the document is keyed under (deletable by it). */
  userId: string;
  /** The identity ref it belongs to. */
  ref: string;
  content: string;
  updatedAt: string;
}

/** The identity refs that are this account's person (own ref first). */
async function identityRefs(accountId: string, db?: StoreDb): Promise<string[]> {
  const ownRef = scopedRef("chat", "user", accountId);
  const linked = await resolveLinkedRefs([ownRef], db);
  return linked.get(ownRef) ?? [ownRef];
}

/** The linked identities, labeled from the aggregated directory. */
export async function getProfileIdentities(accountId: string): Promise<ProfileIdentity[]> {
  const refs = await identityRefs(accountId);
  const ownRef = scopedRef("chat", "user", accountId);
  const labels = new Map<string, string>();
  try {
    const { entries } = await listDirectoryUsers();
    for (const entry of entries) labels.set(entry.ref, entry.label);
  } catch {
    // Labels are decoration; the refs still render.
  }
  const sourceNames = await sourceLabels();
  return refs.flatMap((ref) => {
    const parsed = tryParseScopedRef(ref);
    if (!parsed) return [];
    return [
      {
        ref,
        source: parsed.source,
        sourceLabel: sourceLabelOf(sourceNames, parsed.source),
        label: labels.get(ref) ?? null,
        self: ref === ownRef,
      },
    ];
  });
}

/**
 * The memory documents held under any of the account's identities. The
 * memory keyspace is scoped refs since the Phase 10 cutover, so the linked
 * refs ARE the document keys.
 */
export async function getProfileMemory(accountId: string): Promise<ProfileMemoryDoc[]> {
  const refs = await identityRefs(accountId);
  // The memory keyspace is scoped refs since the cutover - the identity
  // refs ARE the document keys.
  const docs = await getUserMemoriesFor(getStoreDb(), [...new Set(refs)]);
  return docs.map((doc) => ({
    userId: doc.userId,
    ref: doc.userId,
    content: doc.content,
    updatedAt: doc.updatedAt,
  }));
}

/**
 * Delete one of the OWN memory documents: refused unless the key belongs to
 * one of the acting account's identities. Runs the memory feature's traced
 * delete, so the admin memory page's history shows it like any other.
 */
export async function forgetOwnMemory(accountId: string, userId: string): Promise<void> {
  const refs = new Set(await identityRefs(accountId));
  if (!refs.has(userId)) {
    throw ApiError.forbidden("That memory document is not about you");
  }
  await forgetUser(userId);
}

/**
 * Unlink one of the acting account's OWN platform identities.
 *
 * The mirror image of redeeming a link code, and it has to exist for the same
 * reason: a person who can join an identity to their account must be able to
 * take it back off — a mis-sent code, a bot account they no longer use, a
 * phone number that changed hands. Refused for anything that is not this
 * account's, and for the account's own web identity, which is not a link at
 * all but the thing links are made TO.
 *
 * Removing the last other member leaves a link of one, which means nothing, so
 * the link itself goes.
 */
export async function unlinkOwnIdentity(
  accountId: string,
  ref: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<{ unlinked: string }> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "unlink-identity",
      trigger,
      inputSummary: `unlink ${ref}`,
    },
    async (trace) => {
      const ownRef = scopedRef("chat", "user", accountId);
      if (ref === ownRef) {
        throw ApiError.badRequest("That is your own account identity — it cannot be unlinked");
      }
      const refs = new Set(await identityRefs(accountId, db));
      if (!refs.has(ref)) {
        throw ApiError.forbidden("That identity is not linked to you");
      }

      const links = await findLinksForRefs(db, [ref]);
      const linkId = links.get(ref);
      if (!linkId) {
        // Nothing to undo: it resolved as this person without a link row.
        throw ApiError.badRequest("That identity is not linked to you");
      }
      const members = (await listMembersOfLinks(db, [linkId])).get(linkId) ?? [];
      const remaining = members.filter((member) => member !== ref);

      if (remaining.length < 2) {
        await deletePersonLink(db, linkId);
        trace.event({
          message: "link dropped — one identity is not a link",
          type: "db",
          level: "info",
          data: { linkId, members, remaining },
        });
      } else {
        await replacePersonLinkMembers(db, linkId, remaining);
        trace.event({
          message: "identity removed from the link",
          type: "db",
          level: "info",
          data: { linkId, members, remaining },
        });
      }

      // Both surfaces that show identities: this profile, and the operator's
      // Users page.
      publishEvent("users");
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${ref} unlinked from '${accountId}'`,
        relatedIds: { [FEATURE.relatedIdsKey]: [accountId] },
      });
      return { unlinked: ref };
    },
  );
}

/** Change the acting account's display name (a self-service write). */
export async function updateOwnDisplayName(
  accountId: string,
  displayName: string,
  trigger: TraceTrigger,
): Promise<{ displayName: string | null }> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "update-profile",
      trigger,
      inputSummary: "display name change",
    },
    async (trace) => {
      const row = await getAccountById(accountId);
      if (!row) throw ApiError.unauthorized("Sign in to edit the profile");
      const cleaned = displayName.trim() || null;
      const updated = await updateAccount(row.id, { displayName: cleaned });
      if (!updated) throw ApiError.unauthorized("Sign in to edit the profile");
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `display name ${cleaned ? `set to '${cleaned}'` : "cleared"} for '${row.username}'`,
        relatedIds: { [FEATURE.relatedIdsKey]: [row.id] },
      });
      return { displayName: updated.displayName };
    },
  );
}
