import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLink } from "@/features/person-links/server/service";
import { resetEnvCache } from "@/server/env";
import { closeStorePool } from "@/server/store/db";
import { sourceChatMembers, sourceChats, sourceUsers } from "@/store/schema";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { upsertUserMemory } from "./repository";
import { getMemoryContext, readMemory } from "./service";

/**
 * Memory read through person links: what the bot knows about a human follows
 * them across the identities they reach it by (PLAN.md, "Memory").
 *
 * ONE database since the Phase 10 cutover: memory documents and person links
 * live side by side in the core store, and the memory keyspace is scoped refs
 * (`tg:user:123`, `chat:user:<accountId>`). Consolidated documents are written
 * directly — consolidation itself is covered by the main memory suite; what is
 * under test here is whose documents a read collects.
 */

let ctx: TestStoreDb;
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
  ctx = await startTestStoreDb();
  prevStoreUrl = process.env.STORE_DATABASE_URL;
  // Link resolution and link writes reach the store through the env-bound
  // pool, so point it at the same container database the suite seeds.
  process.env.STORE_DATABASE_URL = ctx.connectionUri;
  resetEnvCache();
});

afterAll(async () => {
  // Production code opened the process-global store pool; close it before the
  // container stops or its dying clients fail an otherwise green run.
  await closeStorePool();
  if (prevStoreUrl === undefined) delete process.env.STORE_DATABASE_URL;
  else process.env.STORE_DATABASE_URL = prevStoreUrl;
  resetEnvCache();
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

async function seedUser(userId: string, firstName: string): Promise<void> {
  await ctx.db
    .insert(sourceUsers)
    .values({ source: "tg", userId, username: firstName.toLowerCase(), firstName })
    .onConflictDoNothing();
}

async function seedGroup(userIds: string[]): Promise<void> {
  await ctx.db
    .insert(sourceChats)
    .values({ source: "tg", chatId: GROUP_ID, title: "Fixture Group", type: "supergroup" })
    .onConflictDoNothing();
  for (const userId of userIds) {
    await ctx.db
      .insert(sourceChatMembers)
      .values({ source: "tg", chatId: GROUP_ID, userId })
      .onConflictDoNothing();
  }
}

/**
 * A consolidated document, as the nightly merge would leave it — keyed by the
 * scoped ref, which is the memory keyspace since the Phase 10 cutover.
 */
async function remember(userRef: string, content: string): Promise<void> {
  await upsertUserMemory(ctx.db, { userId: userRef, content, embedding: null });
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
    await remember(`tg:user:${WORK}`, "Lives in Lisbon.");
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
    await remember(`tg:user:${WORK}`, "Lives in Lisbon.");

    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: STRANGER, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  it("speaks about a linked person once when both their identities are in the group", async () => {
    await seedUser(WORK, "Ada");
    await seedUser(PERSONAL, "Adele");
    await seedGroup([WORK, PERSONAL]);
    await remember(`tg:user:${WORK}`, "Lives in Lisbon.");
    await remember(`tg:user:${PERSONAL}`, "Works nights.");
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
    await remember(`tg:user:${WORK}`, "Lives in Lisbon.");
    await remember(`tg:user:${PERSONAL}`, "Works nights.");
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
    await remember(`tg:user:${WORK}`, "Lives in Lisbon.");
    await remember(`chat:user:${WEB}`, "Prefers short answers.");
    await createLink(
      { members: [`tg:user:${WORK}`, `chat:user:${WEB}`], note: "same person" },
      { kind: "dashboard" },
    );

    // In the web thread: the telegram fact is there, and the person is named
    // by the label the chat app supplied — there is no tg directory row for
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
