import "server-only";

import { tryParseScopedRef } from "@assistant-hub-swarm/contracts";

import { getAssistantById } from "@/features/assistants/server/repository";
import {
  findLinksForRefs,
  listMembersOfLinks,
} from "@/features/person-links/server/repository";
import { getAccountById } from "@/server/auth/accounts";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * Owner-rights resolution (redesign Phase 8, PLAN.md "Assistants"): a sender
 * holds owner rights in a turn iff their account — resolved through identity
 * links — is the assistant's owning account; admins hold owner rights on
 * every assistant. This replaces the global owner identity the tg transport
 * used to resolve from its config.
 *
 * The account's identity ref is its web-chat ref, `chat:user:<accountId>`
 * (web user = account, user decision 2026-08-31): a platform identity is
 * linked to an account by sharing a person link with that ref. A sender who
 * IS the account (a web-chat turn) resolves directly.
 */

/**
 * The active account a sender ref belongs to, or null: the ref itself when
 * it is an account's own web identity, else the account whose web identity
 * shares a person link with the ref.
 */
export async function accountForSenderRef(
  senderRef: string,
  db: StoreDb = getStoreDb(),
): Promise<{ id: string; role: "admin" | "user" } | null> {
  const candidates: string[] = [];
  const direct = tryParseScopedRef(senderRef);
  if (direct?.source === "chat" && direct.kind === "user") candidates.push(direct.id);

  const linkByRef = await findLinksForRefs(db, [senderRef]);
  const linkId = linkByRef.get(senderRef);
  if (linkId) {
    const members = (await listMembersOfLinks(db, [linkId])).get(linkId) ?? [];
    for (const member of members) {
      if (member === senderRef) continue;
      const parsed = tryParseScopedRef(member);
      if (parsed?.source === "chat" && parsed.kind === "user") candidates.push(parsed.id);
    }
  }

  for (const id of candidates) {
    const account = await getAccountById(id, db);
    if (account?.active) return { id: account.id, role: account.role };
  }
  return null;
}

/**
 * Whether this sender holds owner rights over this assistant. Never throws
 * into the message path — an unresolvable ref is simply not the owner.
 */
export async function resolveOwnerRights(
  input: { senderRef: string; assistantId: string },
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  try {
    const account = await accountForSenderRef(input.senderRef, db);
    if (!account) return false;
    if (account.role === "admin") return true;
    const assistant = await getAssistantById(db, input.assistantId);
    // A null owner (pre-auth row) is admin-owned in effect.
    return assistant?.ownerAccountId != null && assistant.ownerAccountId === account.id;
  } catch {
    return false;
  }
}
