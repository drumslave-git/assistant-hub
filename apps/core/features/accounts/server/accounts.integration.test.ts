import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub-swarm/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertAccount } from "@/server/auth/accounts";
import { hashPassword } from "@/server/auth/password";
import { judgeSessionToken, loginAccount } from "@/server/auth/service";
import type { StoreDb } from "@/server/store/db";
import { listTraces } from "@/server/trace";

import * as storeSchema from "../../../store/schema";

import { createAssistant } from "@/features/assistants/server/service";
import { findLinksForRefs, listMembersOfLinks } from "@/features/person-links/server/repository";
import { silencedAssistantIds } from "@/server/ownership";
import { CONTRACT_MAJOR } from "@assistant-hub-swarm/contracts";

import { desiredTransportState } from "@/server/transports/service";

import { unlinkOwnIdentity } from "./profile";
import { LINK_CODE_TTL_MS, mintLinkCode, redeemLinkCode } from "./self-link";
import { createAccount, deleteAccountHard, listAccountViews, patchAccount } from "./service";

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
  await pool.query(
    `TRUNCATE accounts, person_links, assistants, transports, tool_connections CASCADE`,
  );
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

describe("offboarding (Phase 9)", () => {
  it("deactivation silences the account's assistants everywhere it is computed", async () => {
    const adminId = await seedAdmin();
    const user = await createAccount(
      { username: "sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    const mine = await createAssistant(
      { name: "Sam's bot", persona: "" },
      trigger,
      { id: user.id },
      db,
    );
    const admins = await createAssistant(
      { name: "House bot", persona: "" },
      trigger,
      { id: adminId },
      db,
    );
    await pool.query(
      `INSERT INTO transports (id, name, base_url, enabled, contract_major)
       VALUES ('tg', 'Telegram', 'http://x', true, $1)`,
      [CONTRACT_MAJOR],
    );
    await pool.query(
      `INSERT INTO assistant_transports (id, assistant_id, transport, config, enabled)
       VALUES ('c-mine', $1, 'tg', '{}'::jsonb, true), ('c-admin', $2, 'tg', '{}'::jsonb, true)`,
      [mine.id, admins.id],
    );

    await patchAccount(user.id, { active: false }, { id: adminId }, trigger, db);
    expect(await silencedAssistantIds(db)).toEqual(new Set([mine.id]));
    const state = await desiredTransportState("tg", db);
    const byId = new Map(state.connections.map((c) => [c.id, c.enabled]));
    expect(byId.get("c-mine")).toBe(false);
    expect(byId.get("c-admin")).toBe(true);

    // Reactivation restores the exact prior state - nothing was mutated.
    await patchAccount(user.id, { active: true }, { id: adminId }, trigger, db);
    expect(await silencedAssistantIds(db)).toEqual(new Set());
    const restored = await desiredTransportState("tg", db);
    expect(restored.connections.every((c) => c.enabled)).toBe(true);
  });

  it("hard delete requires deactivation and then cascades everything that is only theirs", async () => {
    const adminId = await seedAdmin();
    const user = await createAccount(
      { username: "sam", role: "user", temporaryPassword: "temp-pass-1234" },
      trigger,
      db,
    );
    const mine = await createAssistant(
      { name: "Sam's bot", persona: "" },
      trigger,
      { id: user.id },
      db,
    );
    await pool.query(
      `INSERT INTO web_threads (id, user_id, assistant_id, name) VALUES ('t-1', $1, $2, 'Chat')`,
      [user.id, mine.id],
    );
    await pool.query(
      `INSERT INTO tool_connections (id, slug, name, transport, endpoint_url, owner_account_id)
       VALUES ('tc-1', 'mine', 'Mine', 'http', 'https://tools.example.test/mcp', $1)`,
      [user.id],
    );
    // Link the account to a platform identity; the link dies with them
    // (fewer than two identities would remain).
    const { code } = await mintLinkCode(user.id, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:777", text: code }, db);

    // Active - refused; the two-step is the confirm.
    await expect(
      deleteAccountHard(user.id, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: expect.stringContaining("Deactivate the account first") });
    // Self-delete refused outright.
    await expect(
      deleteAccountHard(adminId, { id: adminId }, trigger, db),
    ).rejects.toMatchObject({ message: expect.stringContaining("your own account") });

    await patchAccount(user.id, { active: false }, { id: adminId }, trigger, db);
    await deleteAccountHard(user.id, { id: adminId }, trigger, db);

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM accounts WHERE id = $1) AS account,
         (SELECT count(*)::int FROM assistants WHERE id = $2) AS assistant,
         (SELECT count(*)::int FROM web_threads) AS threads,
         (SELECT count(*)::int FROM tool_connections) AS connections,
         (SELECT count(*)::int FROM person_links) AS links,
         (SELECT count(*)::int FROM account_link_codes) AS codes`,
      [user.id, mine.id],
    );
    expect(counts.rows[0]).toEqual({
      account: 0,
      assistant: 0,
      threads: 0,
      connections: 0,
      links: 0,
      codes: 0,
    });
  });
});

describe("unlinking an identity", () => {
  it("takes a linked identity back off and drops a link that would be left alone", async () => {
    const adminId = await seedAdmin();
    const accountRef = `chat:user:${adminId}`;
    const { code } = await mintLinkCode(adminId, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:1001", text: code }, db);
    expect((await findLinksForRefs(db, ["tg:user:1001"])).get("tg:user:1001")).toBeDefined();

    await unlinkOwnIdentity(adminId, "tg:user:1001", trigger, db);

    // The link held exactly two identities, so removing one leaves nothing a
    // link could mean — the row goes with it.
    expect((await findLinksForRefs(db, ["tg:user:1001", accountRef])).size).toBe(0);
  });

  it("keeps the rest of a bigger link, and removes only the one asked for", async () => {
    const adminId = await seedAdmin();
    const accountRef = `chat:user:${adminId}`;
    for (const ref of ["tg:user:1001", "discord:user:2002"]) {
      const { code } = await mintLinkCode(adminId, trigger, db);
      await redeemLinkCode({ senderRef: ref, text: code }, db);
    }

    await unlinkOwnIdentity(adminId, "discord:user:2002", trigger, db);

    const links = await findLinksForRefs(db, [accountRef]);
    const linkId = links.get(accountRef);
    expect(linkId).toBeDefined();
    const members = (await listMembersOfLinks(db, [linkId!])).get(linkId!) ?? [];
    expect([...members].sort()).toEqual([accountRef, "tg:user:1001"].sort());
  });

  it("refuses an identity that is not yours, and your own account identity", async () => {
    const adminId = await seedAdmin();
    const { code } = await mintLinkCode(adminId, trigger, db);
    await redeemLinkCode({ senderRef: "tg:user:1001", text: code }, db);

    // Someone else's identity: not in this account's person at all.
    await expect(
      unlinkOwnIdentity(adminId, "tg:user:9999", trigger, db),
    ).rejects.toThrow(/not linked to you/i);

    // The web identity is what links are made TO; unlinking it is meaningless.
    await expect(
      unlinkOwnIdentity(adminId, `chat:user:${adminId}`, trigger, db),
    ).rejects.toThrow(/cannot be unlinked/i);

    // Neither refusal touched the graph.
    expect((await findLinksForRefs(db, ["tg:user:1001"])).get("tg:user:1001")).toBeDefined();
  });
});
