import { fileURLToPath } from "node:url";

import { applyMigrations } from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { groupMembers, knownGroups, knownUsers } from "@/db/schema";
import { createLink } from "@/features/person-links/server/service";
import { resetEnvCache } from "@/server/env";
import { closeStorePool } from "@/server/store/db";
import { startTestDb, type TestDb } from "@/test/db";

import { upsertUserMemory } from "./repository";
import { getMemoryContext, readMemory } from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Memory read through person links: what the bot knows about a human follows
 * them across the identities they reach it by (PLAN.md, "Memory").
 *
 * Two databases on one container, as the split demands: memory is still on
 * the v1 database until the Phase 6 cutover, while the links live in the v2
 * core store. Consolidated documents are written directly — consolidation
 * itself is covered by the main memory suite; what is under test here is
 * whose documents a read collects.
 */

let ctx: TestDb;
let storePool: Pool;
let prevDatabaseUrl: string | undefined;
let prevStoreUrl: string | undefined;

const CHAT_ID = "900";
const GROUP_ID = "-100900";
/** Two accounts of one person, and an unrelated third. */
const WORK = "701";
const PERSONAL = "702";
const STRANGER = "800";
/** The same person's web identity — a uuid, as the chat app mints them. */
const WEB = "0b1c2d3e-4f56-4789-8abc-def012345678";

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  prevStoreUrl = process.env.STORE_DATABASE_URL;
  process.env.DATABASE_URL = ctx.connectionUri;

  const admin = new Pool({ connectionString: ctx.connectionUri });
  try {
    await admin.query(`CREATE DATABASE core_store`);
  } finally {
    await admin.end();
  }
  const storeUrl = ctx.connectionUri.replace(/\/[^/?]+(\?|$)/, "/core_store$1");
  await applyMigrations(storeUrl, STORE_MIGRATIONS);
  process.env.STORE_DATABASE_URL = storeUrl;
  resetEnvCache();
  storePool = new Pool({ connectionString: storeUrl });
});

afterAll(async () => {
  await storePool?.end();
  // Production code opened the process-global store pool; close it before the
  // container stops or its dying clients fail an otherwise green run.
  await closeStorePool();
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  if (prevStoreUrl === undefined) delete process.env.STORE_DATABASE_URL;
  else process.env.STORE_DATABASE_URL = prevStoreUrl;
  resetEnvCache();
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  await storePool.query(`TRUNCATE person_links RESTART IDENTITY CASCADE`);
});

async function seedUser(userId: string, firstName: string): Promise<void> {
  await ctx.db
    .insert(knownUsers)
    .values({ userId, username: firstName.toLowerCase(), firstName })
    .onConflictDoNothing();
}

async function seedGroup(userIds: string[]): Promise<void> {
  await ctx.db
    .insert(knownGroups)
    .values({ chatId: GROUP_ID, title: "Fixture Group", type: "supergroup" })
    .onConflictDoNothing();
  for (const userId of userIds) {
    await ctx.db
      .insert(groupMembers)
      .values({ chatId: GROUP_ID, userId })
      .onConflictDoNothing();
  }
}

/** A consolidated document, as the nightly merge would leave it. */
async function remember(userId: string, content: string): Promise<void> {
  await upsertUserMemory(ctx.db, { userId, content, embedding: null });
}

/** Declare the two accounts one person. */
async function link(): Promise<void> {
  await createLink(
    { members: [`tg:user:${WORK}`, `tg:user:${PERSONAL}`], note: "same person" },
    { kind: "dashboard" },
  );
}

describe("memory through person links", () => {
  it("surfaces a fact stored under the other identity of the same person", async () => {
    await seedUser(WORK, "Ada");
    await seedUser(PERSONAL, "Adele");
    await remember(WORK, "Lives in Lisbon.");
    await link();

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: PERSONAL, isGroup: false },
      ctx.db,
    );

    expect(context?.content).toContain("Lives in Lisbon.");
    // Named by the identity actually here, not by the one that holds the fact.
    expect(context?.content).toContain("Adele (@adele) (the person you are replying to)");
    expect(context?.data).toMatchObject({ userIds: [PERSONAL], factCount: 1 });
  });

  it("keeps unlinked identities separate", async () => {
    await seedUser(WORK, "Ada");
    await seedUser(STRANGER, "Grace");
    await remember(WORK, "Lives in Lisbon.");

    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: STRANGER, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  it("speaks about a linked person once when both their identities are in the group", async () => {
    await seedUser(WORK, "Ada");
    await seedUser(PERSONAL, "Adele");
    await seedGroup([WORK, PERSONAL]);
    await remember(WORK, "Lives in Lisbon.");
    await remember(PERSONAL, "Works nights.");
    await link();

    const context = await getMemoryContext(
      { chatId: GROUP_ID, senderId: WORK, isGroup: true },
      ctx.db,
    );

    // One block, carrying both identities' facts.
    expect(context?.data).toMatchObject({ userIds: [WORK], factCount: 2 });
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.content).toContain("Works nights.");
    expect(context?.content).not.toContain("Adele (@adele):");
  });

  it("answers the memory tool with the whole person's facts, under the id it was asked about", async () => {
    await seedUser(WORK, "Ada");
    await seedUser(PERSONAL, "Adele");
    await remember(WORK, "Lives in Lisbon.");
    await remember(PERSONAL, "Works nights.");
    await link();

    const facts = await readMemory({ userId: PERSONAL }, ctx.db);
    expect(facts.map((fact) => fact.content).sort()).toEqual([
      "Lives in Lisbon.",
      "Works nights.",
    ]);
    expect(new Set(facts.map((fact) => fact.userId))).toEqual(new Set([PERSONAL]));
  });

  it("carries what telegram taught it into a web thread, and back", async () => {
    // The pair the whole person-link design exists for: one human reaching
    // the assistant through two different apps.
    await seedUser(WORK, "Ada");
    await remember(WORK, "Lives in Lisbon.");
    await remember(WEB, "Prefers short answers.");
    await createLink(
      { members: [`tg:user:${WORK}`, `chat:user:${WEB}`], note: "same person" },
      { kind: "dashboard" },
    );

    // In the web thread: the telegram fact is there, and the person is named
    // by the label the chat app supplied — there is no v1 directory row for
    // a web user, and "User 0b1c…" is not a name.
    const inThread = await getMemoryContext(
      {
        chatId: "thread-1",
        senderId: WEB,
        isGroup: false,
        source: "chat",
        labels: { [WEB]: "Operator" },
      },
      ctx.db,
    );
    expect(inThread?.content).toContain("Lives in Lisbon.");
    expect(inThread?.content).toContain("Prefers short answers.");
    expect(inThread?.content).toContain("Operator");
    expect(inThread?.content).not.toContain(WEB);

    // And in Telegram: what was learned in the web thread is known there too.
    const inTelegram = await getMemoryContext(
      { chatId: CHAT_ID, senderId: WORK, isGroup: false },
      ctx.db,
    );
    expect(inTelegram?.content).toContain("Prefers short answers.");
    expect(inTelegram?.content).toContain("Ada");

    // The tool answers the same way, asked from either side.
    const fromWeb = await readMemory({ userId: WEB, source: "chat" }, ctx.db);
    expect(fromWeb.map((fact) => fact.content).sort()).toEqual([
      "Lives in Lisbon.",
      "Prefers short answers.",
    ]);
  });
});
