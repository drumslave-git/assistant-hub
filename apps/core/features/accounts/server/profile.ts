import "server-only";

import { scopedRef, tryParseScopedRef } from "@assistant-hub/contracts";

import { getUserMemoriesFor } from "@/features/memory/server/repository";
import { forgetUser } from "@/features/memory/server/service";
import { resolveLinkedRefs } from "@/features/person-links/server/service";
import { directorySourceLabel, listDirectoryUsers } from "@/server/source/directory";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getAccountById, updateAccount } from "@/server/auth/accounts";
import { getDb } from "@/db/drizzle";
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
  /** The local id the document is keyed under (deletable by it). */
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
  return refs.flatMap((ref) => {
    const parsed = tryParseScopedRef(ref);
    if (!parsed) return [];
    return [
      {
        ref,
        source: parsed.source,
        sourceLabel: directorySourceLabel(parsed.source),
        label: labels.get(ref) ?? null,
        self: ref === ownRef,
      },
    ];
  });
}

/**
 * The memory documents held under any of the account's identities. The
 * memory keyspace is flat local ids (v1 shape until cutover), so each ref's
 * local id indexes its document.
 */
export async function getProfileMemory(accountId: string): Promise<ProfileMemoryDoc[]> {
  const refs = await identityRefs(accountId);
  const byLocalId = new Map<string, string>();
  for (const ref of refs) {
    const parsed = tryParseScopedRef(ref);
    if (parsed?.kind === "user") byLocalId.set(parsed.id, ref);
  }
  const docs = await getUserMemoriesFor(getDb(), [...byLocalId.keys()]);
  return docs.map((doc) => ({
    userId: doc.userId,
    ref: byLocalId.get(doc.userId) ?? scopedRef("chat", "user", doc.userId),
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
  const refs = await identityRefs(accountId);
  const ownIds = new Set(
    refs.flatMap((ref) => {
      const parsed = tryParseScopedRef(ref);
      return parsed?.kind === "user" ? [parsed.id] : [];
    }),
  );
  if (!ownIds.has(userId)) {
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
