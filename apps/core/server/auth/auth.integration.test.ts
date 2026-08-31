import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import type { StoreDb } from "@/server/store/db";
import { listTraces } from "@/server/trace";

import * as storeSchema from "../../store/schema";

import { insertAccount } from "./accounts";
import { hashPassword } from "./password";
import { sessionCookie } from "./session";
import {
  changeAccountPassword,
  isAuthConfigured,
  judgeSessionToken,
  loginAccount,
  requireAccount,
  requireOperator,
  setupFirstAdmin,
} from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/**
 * The account-auth flow against a real database (redesign Phase 8):
 * first-run setup of the first admin, username+password login, per-account
 * session judgement, the forced temporary-password change, and the API
 * gate — including the trace record every attempt leaves behind.
 */

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("auth");
  await applyMigrations(url, STORE_MIGRATIONS);
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema: storeSchema });
});

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE accounts CASCADE`);
});

const trigger = { kind: "test" } as const;

const request = (cookie?: string): Request =>
  new Request("http://localhost/api/x", { headers: cookie ? { cookie } : {} });

const setup = () => setupFirstAdmin({ username: "anna", password: "hunter2hunter2" }, trigger, db);

describe("account auth", () => {
  it("walks the first-run path: unconfigured → setup → valid admin session", async () => {
    expect(await isAuthConfigured(db)).toBe(false);
    expect(await judgeSessionToken(null, db)).toEqual({ kind: "unconfigured" });

    const { token } = await setup();
    expect(await isAuthConfigured(db)).toBe(true);
    const verdict = await judgeSessionToken(token, db);
    expect(verdict.kind).toBe("ok");
    if (verdict.kind === "ok") {
      expect(verdict.account).toMatchObject({
        username: "anna",
        displayName: "anna",
        role: "admin",
        mustChangePassword: false,
      });
    }
    expect(await judgeSessionToken("forged.token.sig", db)).toEqual({ kind: "invalid" });
  });

  it("refuses a second setup — accounts cannot be seized unauthenticated", async () => {
    await setup();
    await expect(
      setupFirstAdmin({ username: "attacker", password: "attacker-pass-123" }, trigger, db),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a bad setup username and a too-short password", async () => {
    await expect(
      setupFirstAdmin({ username: "a b", password: "hunter2hunter2" }, trigger, db),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      setupFirstAdmin({ username: "anna", password: "short" }, trigger, db),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("logs in with the right credentials (username case-insensitively), rejects wrong ones, and traces both", async () => {
    await setup();

    const { token } = await loginAccount(
      { username: "ANNA", password: "hunter2hunter2" },
      trigger,
      db,
    );
    expect((await judgeSessionToken(token, db)).kind).toBe("ok");

    await expect(
      loginAccount({ username: "anna", password: "wrong-password" }, trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized" });
    // Unknown usernames answer identically to wrong passwords.
    await expect(
      loginAccount({ username: "nobody", password: "hunter2hunter2" }, trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized", message: "Wrong username or password" });

    const traces = await listTraces({ feature: "auth" });
    const byAction = traces.traces.map((t) => `${t.action}:${t.status}`).sort();
    expect(byAction).toEqual(["login:error", "login:error", "login:success", "setup:success"]);
    // The password itself must never be recorded anywhere in a trace.
    expect(JSON.stringify(traces)).not.toContain("hunter2hunter2");
  });

  it("refuses a deactivated account", async () => {
    await setup();
    await insertAccount(
      {
        id: randomUUID(),
        username: "parked",
        passwordHash: hashPassword("hunter2hunter2"),
        role: "user",
        sessionSecret: "parked-secret",
        active: false,
      },
      db,
    );
    await expect(
      loginAccount({ username: "parked", password: "hunter2hunter2" }, trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized", message: "This account is deactivated" });
  });

  it("gates a request by its session cookie and hands back the acting account", async () => {
    await setup();
    const { token } = await loginAccount(
      { username: "anna", password: "hunter2hunter2" },
      trigger,
      db,
    );

    const account = await requireAccount(request(sessionCookie(token).split(";")[0]), db);
    expect(account?.username).toBe("anna");
    await expect(requireAccount(request(), db)).rejects.toBeInstanceOf(ApiError);
    await expect(requireOperator(request("op_session=forged.x.y.z"), db)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("stays open before setup so a fresh install can reach the dashboard API", async () => {
    expect(await requireAccount(request(), db)).toBeNull();
  });
});

describe("password change", () => {
  it("changes the password, signs out that account's other sessions only, and clears the temp hold", async () => {
    const { token: adminToken } = await setup();
    const userId = randomUUID();
    await insertAccount(
      {
        id: userId,
        username: "newbie",
        passwordHash: hashPassword("temp-pass-1234"),
        role: "user",
        sessionSecret: "newbie-secret",
        mustChangePassword: true,
      },
      db,
    );
    const { token: tempSession } = await loginAccount(
      { username: "newbie", password: "temp-pass-1234" },
      trigger,
      db,
    );
    const before = await judgeSessionToken(tempSession, db);
    expect(before.kind === "ok" && before.account.mustChangePassword).toBe(true);

    const { token: fresh } = await changeAccountPassword(
      userId,
      "temp-pass-1234",
      "brand-new-pass",
      trigger,
      db,
    );

    // The rotation invalidates the account's pre-change sessions; the fresh
    // token works and the forced-change hold is gone. The admin's session —
    // a different account — is untouched.
    expect(await judgeSessionToken(tempSession, db)).toEqual({ kind: "invalid" });
    const after = await judgeSessionToken(fresh, db);
    expect(after.kind === "ok" && after.account.mustChangePassword).toBe(false);
    expect((await judgeSessionToken(adminToken, db)).kind).toBe("ok");

    // Old password is dead, new one logs in.
    await expect(
      loginAccount({ username: "newbie", password: "temp-pass-1234" }, trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const { token } = await loginAccount(
      { username: "newbie", password: "brand-new-pass" },
      trigger,
      db,
    );
    expect((await judgeSessionToken(token, db)).kind).toBe("ok");

    const traces = await listTraces({ feature: "auth" });
    expect(traces.traces.map((t) => `${t.action}:${t.status}`)).toContain(
      "change-password:success",
    );
    // Neither the old nor the new password may appear anywhere in a trace.
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("temp-pass-1234");
    expect(serialized).not.toContain("brand-new-pass");
  });

  it("rejects a wrong current password and keeps existing sessions valid", async () => {
    const { token } = await setup();
    const verdict = await judgeSessionToken(token, db);
    if (verdict.kind !== "ok") throw new Error("setup session should be valid");

    await expect(
      changeAccountPassword(verdict.account.id, "wrong-password", "brand-new-pass", trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized" });

    expect((await judgeSessionToken(token, db)).kind).toBe("ok");
    const traces = await listTraces({ feature: "auth" });
    expect(traces.traces.map((t) => `${t.action}:${t.status}`)).toContain("change-password:error");
  });

  it("rejects a too-short new password without checking the current one", async () => {
    const { token } = await setup();
    const verdict = await judgeSessionToken(token, db);
    if (verdict.kind !== "ok") throw new Error("setup session should be valid");
    await expect(
      changeAccountPassword(verdict.account.id, "hunter2hunter2", "short", trigger, db),
    ).rejects.toMatchObject({ code: "bad_request" });
    // Unchanged: the old password still logs in.
    await expect(
      loginAccount({ username: "anna", password: "hunter2hunter2" }, trigger, db),
    ).resolves.toBeTruthy();
  });
});
