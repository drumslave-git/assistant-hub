import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import {
  getAccountById,
  getAccountByUsername,
  insertAccount,
  listAccounts,
  updateAccount,
  type AccountRow,
} from "@/server/auth/accounts";
import { hashPassword } from "@/server/auth/password";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";

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
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${action} ok for '${updated.username}'`,
        relatedIds: { [FEATURE.relatedIdsKey]: [updated.id] },
      });
      return toView(updated);
    },
  );
}
