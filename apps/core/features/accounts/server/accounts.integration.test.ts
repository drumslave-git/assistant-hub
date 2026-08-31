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

import { insertAccount } from "@/server/auth/accounts";
import { hashPassword } from "@/server/auth/password";
import { judgeSessionToken, loginAccount } from "@/server/auth/service";
import type { StoreDb } from "@/server/store/db";
import { listTraces } from "@/server/trace";

import * as storeSchema from "../../../store/schema";

import { createAccount, listAccountViews, patchAccount } from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Account management against a real database (redesign Phase 8): the create
 * flow with its temporary password, and the management actions with their
 * self-lockout and last-admin guards.
 */

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("accounts");
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

/** Seed the acting admin directly (setup is the auth suite's subject). */
async function seedAdmin(): Promise<string> {
  const id = randomUUID();
  await insertAccount(
    {
      id,
      username: "root-admin",
      passwordHash: hashPassword("hunter2hunter2"),
      role: "admin",
      sessionSecret: "root-secret",
    },
    db,
  );
  return id;
}

describe("account creation", () => {
  it("creates an account that must replace its temporary password, and traces it", async () => {
    await seedAdmin();
    const view = await createAccount(
      { username: "sam", displayName: "Sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    expect(view).toMatchObject({
      username: "sam",
      displayName: "Sam",
      role: "user",
      active: true,
      mustChangePassword: true,
    });

    // The temporary password signs in and lands in the forced-change state.
    const { token } = await loginAccount(
      { username: "sam", password: "temp-pass-1234" },
      trigger,
      db,
    );
    const verdict = await judgeSessionToken(token, db);
    expect(verdict.kind === "ok" && verdict.account.mustChangePassword).toBe(true);

    const traces = await listTraces({ feature: "accounts" });
    expect(traces.traces.map((t) => `${t.action}:${t.status}`)).toContain("create:success");
    // The temporary password must never be recorded anywhere in a trace.
    expect(JSON.stringify(traces)).not.toContain("temp-pass-1234");
  });

  it("refuses a duplicate username, case-insensitively", async () => {
    await seedAdmin();
    await createAccount(
      { username: "sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    await expect(
      createAccount({ username: "SAM", role: "user", temporaryPassword: "temp-pass-1234" }, trigger, db),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("management actions", () => {
  it("deactivation blocks sign-in and kills live sessions; reactivation restores", async () => {
    const adminId = await seedAdmin();
    const view = await createAccount(
      { username: "sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    const { token } = await loginAccount(
      { username: "sam", password: "temp-pass-1234" },
      trigger,
      db,
    );

    await patchAccount(view.id, { active: false }, { id: adminId }, trigger, db);
    expect(await judgeSessionToken(token, db)).toEqual({ kind: "invalid" });
    await expect(
      loginAccount({ username: "sam", password: "temp-pass-1234" }, trigger, db),
    ).rejects.toMatchObject({ message: "This account is deactivated" });

    await patchAccount(view.id, { active: true }, { id: adminId }, trigger, db);
    await expect(
      loginAccount({ username: "sam", password: "temp-pass-1234" }, trigger, db),
    ).resolves.toBeTruthy();
  });

  it("guards: no self-deactivation, no self-demotion, and the last active admin stays", async () => {
    const adminId = await seedAdmin();
    await expect(
      patchAccount(adminId, { active: false }, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: "You cannot deactivate your own account" });
    await expect(
      patchAccount(adminId, { role: "user" }, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: "You cannot change your own role" });

    // A second admin acting on the first: allowed only while another active
    // admin remains — here the actor IS the other admin, so both pass; then
    // the demoted one cannot demote the survivor.
    const other = await createAccount(
      { username: "second", role: "admin", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    await patchAccount(adminId, { role: "user" }, { id: other.id }, trigger, db);
    await expect(
      patchAccount(other.id, { role: "user" }, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: expect.stringContaining("last active admin") });
    await expect(
      patchAccount(other.id, { active: false }, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: expect.stringContaining("last active admin") });
  });

  it("a fresh temporary password signs the holder out everywhere and re-arms the hold", async () => {
    const adminId = await seedAdmin();
    const view = await createAccount(
      { username: "sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    const { token } = await loginAccount(
      { username: "sam", password: "temp-pass-1234" },
      trigger,
      db,
    );

    await patchAccount(view.id, { temporaryPassword: "fresh-pass-5678" }, { id: adminId }, trigger, db);
    expect(await judgeSessionToken(token, db)).toEqual({ kind: "invalid" });
    await expect(
      loginAccount({ username: "sam", password: "temp-pass-1234" }, trigger, db),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const { token: fresh } = await loginAccount(
      { username: "sam", password: "fresh-pass-5678" },
      trigger,
      db,
    );
    const verdict = await judgeSessionToken(fresh, db);
    expect(verdict.kind === "ok" && verdict.account.mustChangePassword).toBe(true);

    // Neither temporary password may appear anywhere in a trace.
    const serialized = JSON.stringify(await listTraces({ feature: "accounts" }));
    expect(serialized).not.toContain("temp-pass-1234");
    expect(serialized).not.toContain("fresh-pass-5678");
  });

  it("lists the roster without ever exposing a hash or secret", async () => {
    await seedAdmin();
    const views = await listAccountViews(db);
    expect(views).toHaveLength(1);
    expect(JSON.stringify(views)).not.toContain("scrypt");
    expect(JSON.stringify(views)).not.toContain("root-secret");
  });
});
