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

import { insertPersonLink } from "@/features/person-links/server/repository";
import { insertAccount } from "@/server/auth/accounts";
import type { StoreDb } from "@/server/store/db";

import * as storeSchema from "../store/schema";

import { accountForSenderRef, resolveOwnerRights } from "./owner-rights";
import { ownedAssistantIds, requireAssistantOwnership } from "./ownership";

const STORE_MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

/**
 * Owner-rights resolution against a real database (redesign Phase 8): the
 * sender's account is found through identity links (or directly, for a
 * web-chat sender), and rights follow assistant ownership — admins hold
 * them everywhere, everyone else only on assistants their account owns.
 */

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("owner_rights");
  await applyMigrations(url, STORE_MIGRATIONS);
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema: storeSchema });
});

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE accounts, assistants, person_links CASCADE`);
});

async function seedAccount(role: "admin" | "user", active = true): Promise<string> {
  const id = randomUUID();
  await insertAccount(
    {
      id,
      username: `u-${id.slice(0, 8)}`,
      passwordHash: "scrypt:x",
      role,
      sessionSecret: "s",
      active,
    },
    db,
  );
  return id;
}

async function seedAssistant(ownerAccountId: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assistants (id, name, persona, owner_account_id) VALUES ($1, $2, '', $3)`,
    [id, `Assistant ${id.slice(0, 8)}`, ownerAccountId],
  );
  return id;
}

describe("accountForSenderRef", () => {
  it("resolves a web-chat sender directly — the ref IS the account", async () => {
    const accountId = await seedAccount("user");
    expect(await accountForSenderRef(`chat:user:${accountId}`, db)).toEqual({
      id: accountId,
      role: "user",
    });
  });

  it("resolves a platform identity through its person link", async () => {
    const accountId = await seedAccount("user");
    await insertPersonLink(db, {
      id: randomUUID(),
      note: null,
      members: ["tg:user:1001", `chat:user:${accountId}`],
    });
    expect(await accountForSenderRef("tg:user:1001", db)).toEqual({
      id: accountId,
      role: "user",
    });
  });

  it("finds no account for an unlinked identity or a deactivated account", async () => {
    expect(await accountForSenderRef("tg:user:404", db)).toBeNull();
    const parked = await seedAccount("user", false);
    expect(await accountForSenderRef(`chat:user:${parked}`, db)).toBeNull();
  });
});

describe("resolveOwnerRights", () => {
  it("grants the assistant's owning account, through the link", async () => {
    const owner = await seedAccount("user");
    const stranger = await seedAccount("user");
    const assistantId = await seedAssistant(owner);
    await insertPersonLink(db, {
      id: randomUUID(),
      note: null,
      members: ["tg:user:1001", `chat:user:${owner}`],
    });
    await insertPersonLink(db, {
      id: randomUUID(),
      note: null,
      members: ["tg:user:2002", `chat:user:${stranger}`],
    });

    expect(await resolveOwnerRights({ senderRef: "tg:user:1001", assistantId }, db)).toBe(true);
    expect(await resolveOwnerRights({ senderRef: "tg:user:2002", assistantId }, db)).toBe(false);
    expect(await resolveOwnerRights({ senderRef: "tg:user:404", assistantId }, db)).toBe(false);
  });

  it("grants admins on every assistant, owned or not", async () => {
    const admin = await seedAccount("admin");
    const someoneElse = await seedAccount("user");
    const owned = await seedAssistant(someoneElse);
    const preAuth = await seedAssistant(null);
    await insertPersonLink(db, {
      id: randomUUID(),
      note: null,
      members: ["tg:user:9", `chat:user:${admin}`],
    });

    expect(await resolveOwnerRights({ senderRef: "tg:user:9", assistantId: owned }, db)).toBe(true);
    expect(await resolveOwnerRights({ senderRef: "tg:user:9", assistantId: preAuth }, db)).toBe(
      true,
    );
  });

  it("a null-owner (pre-auth) assistant grants nobody but admins", async () => {
    const user = await seedAccount("user");
    const preAuth = await seedAssistant(null);
    expect(
      await resolveOwnerRights({ senderRef: `chat:user:${user}`, assistantId: preAuth }, db),
    ).toBe(false);
  });
});

describe("ownership helpers (Phase 9)", () => {
  it("scopes user actors to their own assistants and answers not-found for the rest", async () => {
    const owner = await seedAccount("user");
    const other = await seedAccount("user");
    const admin = await seedAccount("admin");
    const mine = await seedAssistant(owner);
    const theirs = await seedAssistant(other);

    // Admin: unrestricted (null = all).
    expect(await ownedAssistantIds({ id: admin, role: "admin" }, db)).toBeNull();
    await expect(
      requireAssistantOwnership({ id: admin, role: "admin" }, theirs, db),
    ).resolves.toBeUndefined();

    // User: the owned set, and a hard not-found on anything else —
    // including ids that do not exist at all (no leak either way).
    const owned = await ownedAssistantIds({ id: owner, role: "user" }, db);
    expect(owned).toEqual(new Set([mine]));
    await expect(
      requireAssistantOwnership({ id: owner, role: "user" }, mine, db),
    ).resolves.toBeUndefined();
    await expect(
      requireAssistantOwnership({ id: owner, role: "user" }, theirs, db),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      requireAssistantOwnership({ id: owner, role: "user" }, "no-such-assistant", db),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
