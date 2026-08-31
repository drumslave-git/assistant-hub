import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import { MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH, USERNAME_PATTERN } from "@/lib/auth";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";

import {
  anyAccountExists,
  getAccountById,
  getAccountByUsername,
  insertAccount,
  updateAccount,
  type AccountRow,
} from "./accounts";
import { hashPassword, verifyPassword } from "./password";
import {
  mintSessionToken,
  readSessionCookie,
  sessionTokenAccountId,
  verifySessionToken,
} from "./session";

/**
 * Account authentication (redesign Phase 8, superseding the single operator
 * password of 2026-07-20): DB-backed accounts with username + password and a
 * role, and stateless session cookies signed per account — a password change
 * rotates that account's secret and signs out that account only. First-run
 * `/setup` creates the first admin. The real gates are server-side where the
 * database is reachable — `defineRoute` for every API and the dashboard route
 * group's layout for pages; `proxy.ts` only does the optimistic
 * cookie-presence redirect the Next.js auth guide prescribes.
 */

const FEATURE = FEATURES["auth"];

export { MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH };

/** A flat cost on every failed login, blunting online brute force. */
const FAILED_LOGIN_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The signed-in account, as sessions and gates see it. Never the secrets. */
export interface SessionAccount {
  id: string;
  username: string;
  /** Display name, already fallen back to the username. */
  displayName: string;
  role: "admin" | "user";
  /** True while a temporary password holds the session at the change form. */
  mustChangePassword: boolean;
}

function toSessionAccount(row: AccountRow): SessionAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  };
}

/** Validate a username shape; throws `bad_request` when it does not hold. */
export function assertValidUsername(username: string): void {
  if (username.length < MIN_USERNAME_LENGTH) {
    throw ApiError.badRequest(`Username must be at least ${MIN_USERNAME_LENGTH} characters`);
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw ApiError.badRequest(
      "Username may contain only letters, digits, dots, dashes and underscores",
    );
  }
}

/** Whether any account exists (drives the first-run /setup redirect). */
export async function isAuthConfigured(db: StoreDb = getStoreDb()): Promise<boolean> {
  return anyAccountExists(db);
}

/**
 * First-run setup: create the first admin account and open its session.
 * Self-sealing — refuses to run once any account exists, so it cannot be
 * used to seize an installed instance.
 */
export async function setupFirstAdmin(
  input: { username: string; password: string },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<{ token: string }> {
  return withTrace(
    // The password itself must never appear anywhere in the trace.
    { feature: FEATURE.id, action: "setup", trigger, inputSummary: "first-run admin setup" },
    async (trace) => {
      assertValidUsername(input.username);
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      if (await anyAccountExists(db)) {
        throw ApiError.conflict("Setup already ran — accounts exist; sign in instead");
      }
      const sessionSecret = randomBytes(32).toString("base64url");
      const row = await insertAccount(
        {
          id: randomUUID(),
          username: input.username,
          passwordHash: hashPassword(input.password),
          role: "admin",
          sessionSecret,
        },
        db,
      );
      await trace.event({
        type: "db",
        message: "first admin account created (hash only)",
        data: { accountId: row.id, username: row.username },
      });
      await trace.succeed({ outputSummary: `admin '${row.username}' created; session opened` });
      return { token: mintSessionToken(row.id, sessionSecret) };
    },
  );
}

/** Verify the credentials and mint a session token. Failures cost a flat delay. */
export async function loginAccount(
  input: { username: string; password: string },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<{ token: string }> {
  return withTrace(
    { feature: FEATURE.id, action: "login", trigger, inputSummary: `login '${input.username}'` },
    async (trace) => {
      if (!(await anyAccountExists(db))) {
        throw ApiError.badRequest("No accounts exist yet — run first-time setup");
      }
      const row = await getAccountByUsername(input.username, db);
      // One failure answer for a wrong username and a wrong password, so a
      // probe cannot enumerate usernames; both cost the same flat delay.
      if (!row || !verifyPassword(input.password, row.passwordHash)) {
        await sleep(FAILED_LOGIN_DELAY_MS);
        // The trace records the failed attempt (feature `auth`, status error).
        throw ApiError.unauthorized("Wrong username or password");
      }
      if (!row.active) {
        await sleep(FAILED_LOGIN_DELAY_MS);
        throw ApiError.unauthorized("This account is deactivated");
      }
      await trace.succeed({ outputSummary: `login ok for '${row.username}'; session opened` });
      return { token: mintSessionToken(row.id, row.sessionSecret) };
    },
  );
}

/**
 * Change the acting account's password. The current password is required even
 * though the route is session-gated — a walked-up-to browser with a live
 * session must not be enough to take over the account. The account's session
 * secret is rotated, so its other sessions are signed out (nobody else's);
 * the fresh token returned here keeps only the caller signed in. Clears the
 * temporary-password hold.
 */
export async function changeAccountPassword(
  accountId: string,
  currentPassword: string,
  newPassword: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<{ token: string }> {
  return withTrace(
    // Neither password may ever appear anywhere in the trace.
    { feature: FEATURE.id, action: "change-password", trigger, inputSummary: "password change" },
    async (trace) => {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const row = await getAccountById(accountId, db);
      if (!row) throw ApiError.unauthorized("Sign in to change the password");
      if (!verifyPassword(currentPassword, row.passwordHash)) {
        await sleep(FAILED_LOGIN_DELAY_MS);
        throw ApiError.unauthorized("Wrong current password");
      }
      const sessionSecret = randomBytes(32).toString("base64url");
      await updateAccount(
        row.id,
        {
          passwordHash: hashPassword(newPassword),
          sessionSecret,
          mustChangePassword: false,
        },
        db,
      );
      await trace.event({
        type: "db",
        message: "password hash replaced; session secret rotated",
        data: { accountId: row.id, username: row.username },
      });
      await trace.succeed({
        outputSummary: `password changed for '${row.username}'; other sessions invalidated`,
      });
      return { token: mintSessionToken(row.id, sessionSecret) };
    },
  );
}

/** How a presented session token stands against the stored auth state. */
export type SessionVerdict =
  | { kind: "ok"; account: SessionAccount }
  | { kind: "unconfigured" }
  | { kind: "invalid" };

/** Judge a raw session token (from the cookie) against the account it names. */
export async function judgeSessionToken(
  token: string | null,
  db: StoreDb = getStoreDb(),
): Promise<SessionVerdict> {
  if (!(await anyAccountExists(db))) return { kind: "unconfigured" };
  const accountId = token ? sessionTokenAccountId(token) : null;
  if (!token || !accountId) return { kind: "invalid" };
  const row = await getAccountById(accountId, db);
  if (!row || !row.active || !verifySessionToken(row.sessionSecret, token)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", account: toSessionAccount(row) };
}

/**
 * The API gate: resolve the request's session to its account, throwing
 * `unauthorized` on an invalid cookie. Returns null while auth is
 * unconfigured — a fresh install's API is open (the dashboard forces
 * `/setup` on first contact, and refusing everything before setup would
 * also break the fresh-install experience).
 */
export async function requireAccount(
  request: Request,
  db: StoreDb = getStoreDb(),
): Promise<SessionAccount | null> {
  const verdict = await judgeSessionToken(readSessionCookie(request.headers.get("cookie")), db);
  if (verdict.kind === "invalid") {
    throw ApiError.unauthorized("Sign in to use the dashboard API");
  }
  return verdict.kind === "ok" ? verdict.account : null;
}

/**
 * Back-compat API gate used by routes that predate role levels: any valid
 * session passes (or an unconfigured fresh install). Replaced by access
 * levels on `defineRoute` in the Phase 8 role-gates slice.
 */
export async function requireOperator(request: Request, db: StoreDb = getStoreDb()): Promise<void> {
  await requireAccount(request, db);
}
