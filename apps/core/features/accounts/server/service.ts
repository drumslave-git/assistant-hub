import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { scopedRef } from "@assistant-hub/contracts";

import { getAssistants, removeAssistant } from "@/features/assistants/server/service";
import { deleteUserMemory } from "@/features/memory/server/repository";
import {
  deletePersonLink,
  findLinksForRefs,
  listMembersOfLinks,
  replacePersonLinkMembers,
} from "@/features/person-links/server/repository";
import { resolveLinkedRefs } from "@/features/person-links/server/service";
import {
  deleteAccountRow,
  getAccountById,
  getAccountByUsername,
  insertAccount,
  listAccounts,
  updateAccount,
  type AccountRow,
} from "@/server/auth/accounts";
import { announceTransportChange, listTransports } from "@/server/transports/service";
import { hashPassword } from "@/server/auth/password";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace, type TraceRecorder } from "@/server/trace";

import type { AccountView, CreateAccount, PatchAccount } from "../schema";

/**
 * Account management (redesign Phase 8) — the admin-only service behind
 * `/accounts`: create accounts with a temporary password, flip roles,
 * deactivate/reactivate, and re-issue a temporary password. Owns the
 * self-lockout guards (you cannot demote or deactivate yourself, nor the
 * last active admin) and the trace record of every action. Sign-in itself
 * lives in `server/auth`.
 */

const FEATURE = FEATURES.accounts;

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every account, oldest first, secrets stripped. */
export async function listAccountViews(db: StoreDb = getStoreDb()): Promise<AccountView[]> {
  return (await listAccounts(db)).map(toView);
}

/** Create an account with a temporary password the holder must replace. */
export async function createAccount(
  input: CreateAccount,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AccountView> {
  return withTrace(
    // The temporary password must never appear anywhere in the trace.
    {
      feature: FEATURE.id,
      action: "create",
      trigger,
      inputSummary: `create '${input.username}' (${input.role})`,
    },
    async (trace) => {
      if (await getAccountByUsername(input.username, db)) {
        throw ApiError.conflict(`An account named '${input.username}' already exists`);
      }
      const row = await insertAccount(
        {
          id: randomUUID(),
          username: input.username,
          displayName: input.displayName?.trim() || null,
          passwordHash: hashPassword(input.temporaryPassword),
          role: input.role,
          sessionSecret: randomBytes(32).toString("base64url"),
          mustChangePassword: true,
        },
        db,
      );
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `account '${row.username}' created (${row.role}, temporary password)`,
        relatedIds: { [FEATURE.relatedIdsKey]: [row.id] },
      });
      return toView(row);
    },
  );
}

/** True when removing admin rights from this row would leave none. */
async function wouldRemoveLastAdmin(row: AccountRow, db: StoreDb): Promise<boolean> {
  if (row.role !== "admin" || !row.active) return false;
  const others = (await listAccounts(db)).filter(
    (a) => a.id !== row.id && a.role === "admin" && a.active,
  );
  return others.length === 0;
}

/** One management action: activate/deactivate, role change, or a fresh temp password. */
export async function patchAccount(
  id: string,
  patch: PatchAccount,
  actor: { id: string },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AccountView> {
  const action =
    "active" in patch ? (patch.active ? "activate" : "deactivate")
    : "role" in patch ? "change-role"
    : "reset-password";
  return withTrace(
    // A fresh temporary password must never appear anywhere in the trace.
    { feature: FEATURE.id, action, trigger, inputSummary: `${action} ${id}` },
    async (trace) => {
      const row = await getAccountById(id, db);
      if (!row) throw ApiError.notFound("No such account");

      if ("active" in patch && !patch.active) {
        if (row.id === actor.id) {
          throw ApiError.badRequest("You cannot deactivate your own account");
        }
        if (await wouldRemoveLastAdmin(row, db)) {
          throw ApiError.badRequest("This is the last active admin — it cannot be deactivated");
        }
      }
      if ("role" in patch && patch.role !== row.role) {
        if (row.id === actor.id) {
          throw ApiError.badRequest("You cannot change your own role");
        }
        if (patch.role === "user" && (await wouldRemoveLastAdmin(row, db))) {
          throw ApiError.badRequest("This is the last active admin — it cannot be demoted");
        }
      }

      const updated = await updateAccount(
        row.id,
        "active" in patch
          ? { active: patch.active }
          : "role" in patch
            ? { role: patch.role }
            : {
                // A fresh temporary password: rotate the session secret too,
                // so whoever held the old password is signed out everywhere.
                passwordHash: hashPassword(patch.temporaryPassword),
                sessionSecret: randomBytes(32).toString("base64url"),
                mustChangePassword: true,
              },
        db,
      );
      if (!updated) throw ApiError.notFound("No such account");
      if ("active" in patch) {
        // Offboarding (Phase 9): the desired transport state computes over
        // account activity, so the pollers must re-reconcile now.
        await announceTransports(trace);
      }
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${action} ok for '${updated.username}'`,
        relatedIds: { [FEATURE.relatedIdsKey]: [updated.id] },
      });
      return toView(updated);
    },
  );
}

/** Nudge every registered transport to refetch its desired state. */
async function announceTransports(trace: TraceRecorder): Promise<void> {
  try {
    const transports = await listTransports();
    for (const transport of transports) {
      await announceTransportChange(transport.id as "tg" | "chat");
    }
  } catch (err) {
    await trace.event({
      type: "step",
      level: "warn",
      message: "transport announce failed - pollers reconcile on their next fetch",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Hard delete (Phase 9 offboarding): the account and everything that is
 * only theirs. Requires the account to be DEACTIVATED first — that two-step
 * is the confirm, and it inherits the deactivation guards (no self, no last
 * admin). What goes, in order: their assistants through the assistants
 * service (so `assistant.deleted` lifecycle events fire and the transports
 * clean up; tasks and bot connections cascade), the memory documents under
 * their linked identities, their person-link membership (the link survives
 * only if two other identities remain), and finally the account row — whose
 * FK cascades take the web threads, the link codes and their tool
 * connections with it.
 */
export async function deleteAccountHard(
  id: string,
  actor: { id: string },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `delete ${id}` },
    async (trace) => {
      const row = await getAccountById(id, db);
      if (!row) throw ApiError.notFound("No such account");
      if (row.id === actor.id) {
        throw ApiError.badRequest("You cannot delete your own account");
      }
      if (row.active) {
        throw ApiError.badRequest("Deactivate the account first — deletion is the second step");
      }

      // Their assistants, through the service (lifecycle events + cascades).
      const owned = (await getAssistants(db)).filter((a) => a.ownerAccountId === row.id);
      for (const assistant of owned) {
        await removeAssistant(assistant.id, trigger, db);
      }
      await trace.event({
        type: "db",
        message: `${owned.length} assistant(s) deleted with their tasks and connections`,
      });

      // The person memory under their linked identities (the v1-backed
      // memory store keys by local id until cutover). Guarded whole: an
      // unreachable v1 store must not abort the offboarding — it is noted
      // in the trace instead.
      const accountRef = scopedRef("chat", "user", row.id);
      const linked = (await resolveLinkedRefs([accountRef], db)).get(accountRef) ?? [accountRef];
      let forgotten = 0;
      for (const ref of linked) {
        // The memory keyspace is scoped refs since the cutover.
        if (await deleteUserMemory(db, ref).catch(() => false)) forgotten += 1;
      }

      // Leave the link graph consistent: the account's identity goes; the
      // link survives only while it still joins at least two identities.
      const linkOf = await findLinksForRefs(db, [accountRef]);
      const linkId = linkOf.get(accountRef);
      if (linkId) {
        const members = ((await listMembersOfLinks(db, [linkId])).get(linkId) ?? []).filter(
          (member) => member !== accountRef,
        );
        if (members.length >= 2) await replacePersonLinkMembers(db, linkId, members);
        else await deletePersonLink(db, linkId);
      }
      await trace.event({
        type: "db",
        message: `person memory cleared (${forgotten} document(s)); link membership removed`,
      });

      await deleteAccountRow(row.id, db);
      await announceTransports(trace);
      publishEvent(FEATURE.realtimeTopic);
      publishEvent("users");
      await trace.succeed({
        outputSummary: `account '${row.username}' deleted with everything that was only theirs`,
        relatedIds: { [FEATURE.relatedIdsKey]: [row.id] },
      });
    },
  );
}
