import "server-only";

import { ApiError } from "@/lib/api-error";
import { getAssistantById, listAssistants } from "@/features/assistants/server/repository";
import { getStoreDb, type StoreDb } from "@/server/store/db";

/**
 * Role-scoped ownership checks (redesign Phase 9, PLAN.md "Assistants" /
 * "MCP tool connections"): admins see and act on everything; a user-role
 * account sees and acts on what its account owns. Every scoped API resolves
 * through these helpers so the rules live once.
 *
 * `Actor` is the acting account as `defineRoute` hands it to a body — null
 * while auth is unconfigured (a fresh install's open API), which behaves as
 * an admin: there is nobody to hide anything from yet.
 */

export interface Actor {
  id: string;
  role: "admin" | "user";
}

/** Whether this actor is scope-restricted (a signed-in user-role account). */
export function isRestricted(actor: Actor | null): actor is Actor {
  return actor?.role === "user";
}

/** Whether the actor may act on a row owned by `ownerAccountId`. */
export function mayActOn(actor: Actor | null, ownerAccountId: string | null): boolean {
  if (!isRestricted(actor)) return true;
  return ownerAccountId != null && ownerAccountId === actor.id;
}

/**
 * The assistant ids this actor's scope covers: null = unrestricted (admin),
 * else the owned set (possibly empty).
 */
export async function ownedAssistantIds(
  actor: Actor | null,
  db: StoreDb = getStoreDb(),
): Promise<Set<string> | null> {
  if (!isRestricted(actor)) return null;
  const all = await listAssistants(db);
  return new Set(all.filter((a) => a.ownerAccountId === actor.id).map((a) => a.id));
}

/**
 * Gate one assistant by ownership. Answers not-found rather than forbidden,
 * so a scoped API does not leak which ids exist.
 */
export async function requireAssistantOwnership(
  actor: Actor | null,
  assistantId: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  if (!isRestricted(actor)) return;
  const assistant = await getAssistantById(db, assistantId);
  if (!assistant || assistant.ownerAccountId !== actor.id) {
    throw ApiError.notFound("Unknown assistant");
  }
}
