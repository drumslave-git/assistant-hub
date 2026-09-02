import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { fakeSourceContent } from "@/test/fake-source-content";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { registerTestTransport } from "@/test/transports";

import { buildSearchableText, runMessageIndexing } from "./index-messages";
import { searchHistoryMessages } from "./search";

/**
 * The indexing JOB's logic — what to index, what text to build, when a row
 * is due again — driven over the in-memory source-content fake. The search
 * SQL itself (hybrid pools, filters, deleted exclusion) lives with the data
 * in the tg app and is pinned by its content suite; what this side owns is
 * the composed text and the job's accounting.
 *
 * No embedding model is configured in the test database, so runs are
 * lexical-only — the degraded mode an operator without an embedding
 * endpoint actually runs in.
 */

const CHAT = "tg:chat:-1001";
const BEA = "200";

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  await registerTestTransport(ctx.db);
});

describe("buildSearchableText", () => {
  it("renders a message as its text plus what its media shows", () => {
    expect(
      buildSearchableText({
        chatRef: CHAT,
        sourceMessageId: "1",
        content: "check this",
        media: { kind: "photo", status: "described", description: "a blue front door" },
      }),
    ).toBe("check this [photo: a blue front door]");
  });

  it("still describes an uncaptioned photo — the case a caption search cannot reach", () => {
    expect(
      buildSearchableText({
        chatRef: CHAT,
        sourceMessageId: "1",
        content: "",
        media: { kind: "photo", status: "described", description: "a blue front door" },
      }),
    ).toBe("[photo: a blue front door]");
  });

  it("marks media that is not described yet, rather than indexing it as empty", () => {
    expect(
      buildSearchableText({
        chatRef: CHAT,
        sourceMessageId: "1",
        content: "",
        media: { kind: "video", status: "pending", description: null },
      }),
    ).toBe("[video]");
  });
});

describe("runMessageIndexing", () => {
  it("indexes the backlog with composed text and leaves nothing due", async () => {
    const content = fakeSourceContent();
    content.addMessage({
      chatRef: CHAT,
      sourceMessageId: "41",
      content: "",
      media: {
        kind: "photo",
        status: "described",
        description: "A weathered blue front door with a brass number 12.",
      },
    });
    content.addMessage({ chatRef: CHAT, sourceMessageId: "42", content: "nice weather" });

    const result = await runMessageIndexing({}, ctx.db, content);
    expect(result.indexed).toBe(2);
    // No embedding model configured in the test database — lexical only.
    expect(result.embedded).toBe(0);
    expect(content.index.get(`${CHAT}|41`)?.content).toBe(
      "[photo: A weathered blue front door with a brass number 12.]",
    );
    expect(content.index.get(`${CHAT}|42`)).toMatchObject({ content: "nice weather", embedding: null });

    const second = await runMessageIndexing({}, ctx.db, content);
    expect(second.indexed).toBe(0);
    expect(second.summary).toBe("index up to date");
  });

  it("re-indexes a message the source marks due again (its description arrived)", async () => {
    const content = fakeSourceContent();
    const row = content.addMessage({
      chatRef: CHAT,
      sourceMessageId: "51",
      content: "",
      media: { kind: "photo", status: "pending", description: null },
    });
    await runMessageIndexing({}, ctx.db, content);
    expect(content.index.get(`${CHAT}|51`)?.content).toBe("[photo]");

    // The backfill wrote the description — the source re-dues the row.
    row.media = { kind: "photo", status: "described", description: "A weathered blue front door." };
    content.markDirty(CHAT, "51");

    const result = await runMessageIndexing({}, ctx.db, content);
    expect(result.indexed).toBe(1);
    expect(content.index.get(`${CHAT}|51`)?.content).toBe("[photo: A weathered blue front door.]");
  });

  it("indexes an empty message with no vector rather than handing it back forever", async () => {
    const content = fakeSourceContent();
    content.addMessage({ chatRef: CHAT, sourceMessageId: "103", content: "" });

    const result = await runMessageIndexing({}, ctx.db, content);
    expect(result.indexed).toBe(1);
    expect((await content.indexDue(10)).total).toBe(0);
  });
});

describe("searchHistoryMessages", () => {
  it("resolves a hit for a human reader — every chat, named sender", async () => {
    await upsertKnownUser(ctx.db, "tg", {
      userId: BEA,
      username: "bea",
      firstName: "Bea",
      lastName: null,
    });
    const content = fakeSourceContent();
    content.addMessage({
      chatRef: "tg:chat:-1002",
      sourceMessageId: "151",
      userId: BEA,
      content: "the door is stuck",
    });

    const hits = await searchHistoryMessages({ query: "door" }, ctx.db, content);
    expect(hits).toHaveLength(1);
    expect(hits[0].chatRef).toBe("tg:chat:-1002");
    expect(hits[0].senderLabel).toContain("Bea");
  });

  it("answers an empty search with nothing rather than everything", async () => {
    const content = fakeSourceContent();
    content.addMessage({ chatRef: CHAT, sourceMessageId: "161", content: "hello" });
    expect(await searchHistoryMessages({ query: "   " }, ctx.db, content)).toEqual([]);
  });
});
