import "server-only";

import { scopedRef, tryParseScopedRef } from "@assistant-hub-swarm/contracts";

import { getUserMemoriesFor } from "@/features/memory/server/repository";
import { forgetUser } from "@/features/memory/server/service";
import { resolveLinkedRefs } from "@/features/person-links/server/service";
import { listDirectoryUsers, sourceLabelOf, sourceLabels } from "@/server/source/directory";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getAccountById, updateAccount } from "@/server/auth/accounts";
import { getStoreDb } from "@/server/store/db";
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
async function identityRefs(accountId: string): Promise<string[]> {
  const ownRef = scopedRef("chat", "user", accountId);
  const linked = await resolveLinkedRefs([ownRef]);
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
