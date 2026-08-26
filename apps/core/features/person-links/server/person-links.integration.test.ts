import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as storeSchema from "../../../store/schema";
import { listTraces } from "@/server/trace";
import type { StoreDb } from "@/server/store/db";
import {
  createLink,
  editLink,
  getPersonLinks,
  removeLink,
  resolveLinkedRefs,
} from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Person links over the v2 core store: CRUD with traces, the
 * one-link-per-identity invariant, and the resolution the memory reader
 * depends on. Synthetic refs only.
 *
 * No source app is configured here, so the directory answers nothing and
 * members come back with a null label — which is exactly the "a source could
 * not be read" shape the dashboard must survive.
 */

const ALICE = "tg:user:1001";
const ALICE_WORK = "tg:user:1002";
const BOB = "tg:user:2001";
const ALICE_WEB = "chat:user:11111111-1111-4111-8111-111111111111";

describe("person links", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("person_links_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE person_links RESTART IDENTITY CASCADE`);
  });

  const trigger = { kind: "dashboard" } as const;

  it("links identities, lists them, and records the action", async () => {
    const created = await createLink(
      { members: [ALICE, ALICE_WEB], note: "same person" },
      trigger,
      db,
    );

    expect(created.note).toBe("same person");
    expect(created.members.map((member) => member.userRef)).toEqual([ALICE, ALICE_WEB]);
    // Sources are unreachable in this suite: the ref stands in for a name
    // rather than a name being invented for it.
    expect(created.members.every((member) => member.label === null)).toBe(true);
    expect(created.members.map((member) => member.source)).toEqual(["tg", "chat"]);

    expect(await getPersonLinks(db)).toHaveLength(1);

    const { traces } = await listTraces({ feature: "person-links" });
    expect(traces.find((trace) => trace.action === "create-link")?.status).toBe("success");
  });

  it("refuses an identity another link already claims", async () => {
    await createLink({ members: [ALICE, ALICE_WEB], note: "" }, trigger, db);

    await expect(createLink({ members: [ALICE, BOB], note: "" }, trigger, db)).rejects.toThrow(
      /already belongs to another person link/,
    );
    // The refused link left nothing behind.
    expect(await getPersonLinks(db)).toHaveLength(1);
  });

  it("edits the note and replaces the identities", async () => {
    const created = await createLink({ members: [ALICE, ALICE_WEB], note: "" }, trigger, db);

    const noted = await editLink(created.id, { note: "work + personal" }, trigger, db);
    expect(noted.note).toBe("work + personal");
    expect(noted.members).toHaveLength(2);

    const regrouped = await editLink(
      created.id,
      { members: [ALICE, ALICE_WORK, ALICE_WEB] },
      trigger,
      db,
    );
    expect(regrouped.members.map((member) => member.userRef)).toEqual([
      ALICE,
      ALICE_WORK,
      ALICE_WEB,
    ]);
    // The note survives an identity change.
    expect(regrouped.note).toBe("work + personal");

    // Keeping its own members is not a conflict with itself.
    await expect(
      editLink(created.id, { members: [ALICE, ALICE_WEB] }, trigger, db),
    ).resolves.toMatchObject({ id: created.id });
  });

  it("unlinks a person, freeing their identities for another link", async () => {
    const created = await createLink({ members: [ALICE, ALICE_WEB], note: "" }, trigger, db);
    await removeLink(created.id, trigger, db);

    expect(await getPersonLinks(db)).toEqual([]);
    await expect(
      createLink({ members: [ALICE, BOB], note: "" }, trigger, db),
    ).resolves.toMatchObject({ note: null });
  });

  describe("resolveLinkedRefs", () => {
    it("resolves an unlinked identity to itself", async () => {
      expect(await resolveLinkedRefs([BOB], db)).toEqual(new Map([[BOB, [BOB]]]));
    });

    it("resolves a linked identity to its whole person, itself first", async () => {
      await createLink({ members: [ALICE, ALICE_WORK, ALICE_WEB], note: "" }, trigger, db);

      const resolved = await resolveLinkedRefs([ALICE_WORK, BOB], db);
      expect(resolved.get(ALICE_WORK)?.[0]).toBe(ALICE_WORK);
      expect([...(resolved.get(ALICE_WORK) ?? [])].sort()).toEqual(
        [ALICE, ALICE_WORK, ALICE_WEB].sort(),
      );
      expect(resolved.get(BOB)).toEqual([BOB]);
    });

    it("asks nothing of the store for an empty request", async () => {
      expect(await resolveLinkedRefs([], db)).toEqual(new Map());
    });
  });
});
