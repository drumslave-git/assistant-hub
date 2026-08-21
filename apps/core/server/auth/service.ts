import "server-only";

import { randomBytes } from "node:crypto";

import { getDb } from "@/db/drizzle";
import type { DrizzleDb } from "@/db/drizzle";
import { getSettingsRecord, upsertSettings } from "@/features/settings/server/repository";
import { ApiError } from "@/lib/api-error";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { withTrace } from "@/server/trace";

import { hashPassword, verifyPassword } from "./password";
import { mintSessionToken, readSessionCookie, verifySessionToken } from "./session";

/**
 * Operator authentication (user decision, 2026-07-20): one DB-backed operator
 * password (set on first run at `/setup`, per `config-in-db-not-env`) and a
 * signed stateless session cookie. The real gates are server-side where the
 * database is reachable — `defineRoute` for every API and the dashboard route
 * group's layout for pages; `proxy.ts` only does the optimistic
 * cookie-presence redirect the Next.js auth guide prescribes.
 */

const FEATURE = FEATURES["auth"];

export { MIN_PASSWORD_LENGTH };

/** A flat cost on every failed login, blunting online brute force. */
const FAILED_LOGIN_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the operator password has been set (drives the /setup redirect). */
export async function isAuthConfigured(db: DrizzleDb = getDb()): Promise<boolean> {
  const record = await getSettingsRecord(db);
  return Boolean(record?.operatorPasswordHash);
}

/**
 * First-run setup: store the password hash and mint the session secret. Refuses
 * to overwrite an existing password — changing it means clearing the column
 * (documented in the README), not an unauthenticated re-setup.
 */
export async function setupOperator(
  password: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ token: string }> {
  return withTrace(
    // The password itself must never appear anywhere in the trace.
    { feature: FEATURE.id, action: "setup", trigger, inputSummary: "first-run password setup" },
    async (trace) => {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const existing = await getSettingsRecord(db);
      if (existing?.operatorPasswordHash) {
        throw ApiError.conflict("The operator password is already set");
      }
      const sessionSecret = randomBytes(32).toString("base64url");
      await upsertSettings(db, { operatorPasswordHash: hashPassword(password), sessionSecret });
      await trace.event({ type: "db", message: "operator password stored (hash only)" });
      await trace.succeed({ outputSummary: "operator password set; session opened" });
      return { token: mintSessionToken(sessionSecret) };
    },
  );
}

/** Verify the password and mint a session token. Failures cost a flat delay. */
export async function loginOperator(
  password: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ token: string }> {
  return withTrace(
    { feature: FEATURE.id, action: "login", trigger, inputSummary: "operator login" },
    async (trace) => {
      const record = await getSettingsRecord(db);
      if (!record?.operatorPasswordHash || !record.sessionSecret) {
        throw ApiError.badRequest("No operator password is set — run first-time setup");
      }
      if (!verifyPassword(password, record.operatorPasswordHash)) {
        await sleep(FAILED_LOGIN_DELAY_MS);
        // The trace records the failed attempt (feature `auth`, status error).
        throw ApiError.unauthorized("Wrong password");
      }
      await trace.succeed({ outputSummary: "login ok; session opened" });
      return { token: mintSessionToken(record.sessionSecret) };
    },
  );
}

/**
 * Change the operator password from inside an authenticated session. The current
 * password is required even though the route is session-gated — a walked-up-to
 * browser with a live session must not be enough to take over the account. The
 * session secret is rotated, so every existing session is signed out; the fresh
 * token returned here keeps only the caller signed in.
 */
export async function changeOperatorPassword(
  currentPassword: string,
  newPassword: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ token: string }> {
  return withTrace(
    // Neither password may ever appear anywhere in the trace.
    { feature: FEATURE.id, action: "change-password", trigger, inputSummary: "operator password change" },
    async (trace) => {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const record = await getSettingsRecord(db);
      if (!record?.operatorPasswordHash || !record.sessionSecret) {
        throw ApiError.badRequest("No operator password is set — run first-time setup");
      }
      if (!verifyPassword(currentPassword, record.operatorPasswordHash)) {
        await sleep(FAILED_LOGIN_DELAY_MS);
        throw ApiError.unauthorized("Wrong current password");
      }
      const sessionSecret = randomBytes(32).toString("base64url");
      await upsertSettings(db, { operatorPasswordHash: hashPassword(newPassword), sessionSecret });
      await trace.event({ type: "db", message: "password hash replaced; session secret rotated" });
      await trace.succeed({ outputSummary: "password changed; all previous sessions invalidated" });
      return { token: mintSessionToken(sessionSecret) };
    },
  );
}

/** How a presented session token stands against the stored auth state. */
export type SessionVerdict = "ok" | "unconfigured" | "invalid";

/** Judge a raw session token (from the cookie) against the stored secret. */
export async function judgeSessionToken(
  token: string | null,
  db: DrizzleDb = getDb(),
): Promise<SessionVerdict> {
  const record = await getSettingsRecord(db);
  if (!record?.operatorPasswordHash || !record.sessionSecret) return "unconfigured";
  if (!token || !verifySessionToken(record.sessionSecret, token)) return "invalid";
  return "ok";
}

/**
 * The API gate: throw `unauthorized` unless the request carries a valid session
 * cookie. Called by `defineRoute` for every non-public route, so the API stays
 * covered even if the proxy layer is bypassed. While auth is unconfigured the
 * API is open — the dashboard forces `/setup` on first contact, and refusing
 * everything before setup would also break the fresh-install experience.
 */
export async function requireOperator(request: Request, db: DrizzleDb = getDb()): Promise<void> {
  const verdict = await judgeSessionToken(readSessionCookie(request.headers.get("cookie")), db);
  if (verdict === "invalid") {
    throw ApiError.unauthorized("Sign in to use the dashboard API");
  }
}
