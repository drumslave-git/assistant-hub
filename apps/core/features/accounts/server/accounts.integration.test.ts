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

import { findLinksForRefs, listMembersOfLinks } from "@/features/person-links/server/repository";

import { LINK_CODE_TTL_MS, mintLinkCode, redeemLinkCode } from "./self-link";
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
  await pool.query(`TRUNCATE accounts, person_links CASCADE`);
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

describe("self-link codes", () => {
  it("mints one live code per account and links a platform identity through it", async () => {
    const adminId = await seedAdmin();
    const first = await mintLinkCode(adminId, trigger, db);
    expect(first.code).toMatch(/^link-[a-z0-9]{8}$/);
    const second = await mintLinkCode(adminId, trigger, db);
    // The first code was retired by the second mint.
    expect(await redeemLinkCode({ senderRef: "tg:user:1001", text: first.code }, db)).toEqual({
      status: "invalid",
    });

    const outcome = await redeemLinkCode(
      { senderRef: "tg:user:1001", text: `  ${second.code.toUpperCase()}  ` },
      db,
    );
    expect(outcome).toEqual({ status: "linked", accountLabel: "root-admin" });

    // The graph now holds one person: the tg identity and the account's ref.
    const accountRef = `chat:user:${adminId}`;
    const links = await findLinksForRefs(db, ["tg:user:1001", accountRef]);
    expect(links.get("tg:user:1001")).toBeDefined();
    expect(links.get("tg:user:1001")).toBe(links.get(accountRef));

    // Burned: the same code answers invalid the second time.
    expect(await redeemLinkCode({ senderRef: "tg:user:2002", text: second.code }, db)).toEqual({
      status: "invalid",
    });
    // The trace never carries the code itself.
    const { listTraces: list } = await import("@/server/trace");
    const serialized = JSON.stringify(await list({ feature: "accounts" }));
    expect(serialized).not.toContain(second.code);
  });

  it("ignores non-code text, answers already-linked, and refuses cross-person merges", async () => {
    const adminId = await seedAdmin();
    expect(await redeemLinkCode({ senderRef: "tg:user:1001", text: "hello there" }, db)).toBeNull();

    const { code } = await mintLinkCode(adminId, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:1001", text: code }, db);

    // Same identity again, fresh code: nothing to do.
    const again = await mintLinkCode(adminId, trigger, db);
    expect(await redeemLinkCode({ senderRef: "tg:user:1001", text: again.code }, db)).toEqual({
      status: "already-linked",
      accountLabel: "root-admin",
    });

    // A sender who already belongs to a DIFFERENT person cannot be pulled in.
    const other = await createAccount(
      { username: "second", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    const otherCode = await mintLinkCode(other.id, trigger, db);
    expect(await redeemLinkCode({ senderRef: "tg:user:1001", text: otherCode.code }, db)).toEqual(
      { status: "conflict" },
    );
  });

  it("expires codes after their TTL and extends an existing person link in place", async () => {
    const adminId = await seedAdmin();
    const { code } = await mintLinkCode(adminId, trigger, db);
    const afterTtl = new Date(Date.now() + LINK_CODE_TTL_MS + 1000);
    expect(await redeemLinkCode({ senderRef: "tg:user:1001", text: code }, db, afterTtl)).toEqual({
      status: "invalid",
    });

    // Link the account first, then a second platform identity joins the
    // SAME link rather than minting a parallel person.
    const one = await mintLinkCode(adminId, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:1001", text: one.code }, db);
    const two = await mintLinkCode(adminId, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:2002", text: two.code }, db);
    const accountRef = `chat:user:${adminId}`;
    const linkId = (await findLinksForRefs(db, [accountRef])).get(accountRef)!;
    const members = (await listMembersOfLinks(db, [linkId])).get(linkId) ?? [];
    expect(new Set(members)).toEqual(new Set(["tg:user:1001", "tg:user:2002", accountRef]));
  });
});
