import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertMedia, markDescribed } from "@/features/vision/server/repository";
import { seedMirrorMessage, startTestDb, type TestDb } from "@/test/db";

import { buildSearchableText, runMessageIndexing } from "./index-messages";
import {
  countMessagesNeedingIndex,
  searchChatMessagesHybrid,
  type MessageSearchMatch,
} from "./search-repository";
import { recordIncomingMessage } from "./service";

/**
 * The scenario this whole path exists for: somebody posts a photo with no caption,
 * and weeks later somebody else asks the bot to find it. Nothing in
 * `chat_messages` can answer that — the row's text is `''`. It is answerable only
 * once the photo's vision description has been folded into a searchable
 * projection of the message, which is what these tests drive end to end.
 *
 * No embedding model is configured in the test database, so the search runs on
 * its lexical halves alone. That is deliberate: it proves the *plumbing* (media
 * description reaching the index and the index reaching the search) rather than a
 * model's recall, and it pins the degraded mode an operator without an embedding
 * endpoint actually runs in.
 */

const CHAT = "-1001";
const ALEX = "100";
const BEA = "200";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

/** Mirror an uncaptioned photo and give it a description, as the pipeline does. */
async function seedDescribedPhoto(input: {
  telegramMessageId: number;
  userId: string;
  description: string;
  kind?: "photo" | "video" | "animation" | "voice";
}): Promise<void> {
  await recordIncomingMessage(
    {
      chatId: CHAT,
      telegramMessageId: input.telegramMessageId,
      userId: input.userId,
      content: "",
      hasMedia: true,
      sentAt: new Date(),
    },
    ctx.db,
  );
  const media = await insertMedia(ctx.db, {
    id: crypto.randomUUID(),
    chatId: CHAT,
    telegramMessageId: input.telegramMessageId,
    kind: input.kind ?? "photo",
    fileId: `file-${input.telegramMessageId}`,
    fileUniqueId: `u${input.telegramMessageId}`,
    mimeType: "image/jpeg",
    dataBase64: "QUJD",
    visionHint: null,
  });
  await markDescribed(ctx.db, media!.id, input.description);
}

/** Lexical-only search, as an unconfigured-embeddings deployment runs it. */
function search(
  queryText: string,
  filters?: Parameters<typeof searchChatMessagesHybrid>[1]["filters"],
): Promise<MessageSearchMatch[]> {
  return searchChatMessagesHybrid(ctx.db, {
    chatId: CHAT,
    queryText,
    queryVector: null,
    limit: 20,
    ...(filters ? { filters } : {}),
  });
}

describe("buildSearchableText", () => {
  it("renders a message as its text plus what its media shows", () => {
    expect(
      buildSearchableText({
        chatId: CHAT,
        telegramMessageId: 1,
        content: "check this",
        media: { kind: "photo", status: "described", description: "a blue front door" },
      }),
    ).toBe("check this [photo: a blue front door]");
  });

  it("still describes an uncaptioned photo — the case a caption search cannot reach", () => {
    expect(
      buildSearchableText({
        chatId: CHAT,
        telegramMessageId: 1,
        content: "",
        media: { kind: "photo", status: "described", description: "a blue front door" },
      }),
    ).toBe("[photo: a blue front door]");
  });

  it("marks media that is not described yet, rather than indexing it as empty", () => {
    expect(
      buildSearchableText({
        chatId: CHAT,
        telegramMessageId: 1,
        content: "",
        media: { kind: "video", status: "pending", description: null },
      }),
    ).toBe("[video]");
  });
});

describe("message search index", () => {
  it("finds an uncaptioned photo by what the picture shows", async () => {
    await seedDescribedPhoto({
      telegramMessageId: 41,
      userId: BEA,
      description: "A weathered blue front door with a brass number 12 and a potted fern beside it.",
    });
    await recordIncomingMessage(
      { chatId: CHAT, telegramMessageId: 42, userId: ALEX, content: "nice weather", sentAt: new Date() },
      ctx.db,
    );

    // Before indexing there is nothing to find: the photo's row holds `''`.
    expect(await search("door")).toEqual([]);

    const result = await runMessageIndexing({}, ctx.db);
    expect(result.indexed).toBe(2);
    // No embedding model configured in the test database — lexical only.
    expect(result.embedded).toBe(0);

    const hits = await search("door");
    expect(hits.map((h) => h.telegramMessageId)).toEqual([41]);
    expect(hits[0].mediaKind).toBe("photo");
    expect(hits[0].indexedContent).toContain("brass number 12");
  });

  it("re-indexes a photo once its description arrives, without being asked", async () => {
    // The ordering that makes this necessary: the message is mirrored instantly,
    // the description is written by the vision backfill minutes or hours later.
    await recordIncomingMessage(
      { chatId: CHAT, telegramMessageId: 51, userId: BEA, content: "", hasMedia: true, sentAt: new Date() },
      ctx.db,
    );
    const media = await insertMedia(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT,
      telegramMessageId: 51,
      kind: "photo",
      fileId: "file-51",
      fileUniqueId: "u51",
      mimeType: "image/jpeg",
      dataBase64: "QUJD",
      visionHint: null,
    });

    await runMessageIndexing({}, ctx.db);
    expect(await search("door")).toEqual([]);
    expect(await countMessagesNeedingIndex(ctx.db)).toBe(0);

    await markDescribed(ctx.db, media!.id, "A weathered blue front door.");

    // The description landing is what makes the message due again.
    expect(await countMessagesNeedingIndex(ctx.db)).toBe(1);
    await runMessageIndexing({}, ctx.db);

    const hits = await search("door");
    expect(hits.map((h) => h.telegramMessageId)).toEqual([51]);
  });

  it("narrows to one person's messages", async () => {
    await seedDescribedPhoto({ telegramMessageId: 61, userId: BEA, description: "A blue front door." });
    await seedDescribedPhoto({ telegramMessageId: 62, userId: ALEX, description: "A red garage door." });
    await runMessageIndexing({}, ctx.db);

    const hits = await search("door", { authorUserIds: [BEA] });
    expect(hits.map((h) => h.telegramMessageId)).toEqual([61]);
  });

  it("narrows to a kind of media", async () => {
    await seedDescribedPhoto({ telegramMessageId: 71, userId: BEA, description: "A blue front door." });
    await seedDescribedPhoto({
      telegramMessageId: 72,
      userId: BEA,
      description: "Someone painting a door.",
      kind: "video",
    });
    await recordIncomingMessage(
      { chatId: CHAT, telegramMessageId: 73, userId: BEA, content: "the door is stuck", sentAt: new Date() },
      ctx.db,
    );
    await runMessageIndexing({}, ctx.db);

    expect((await search("door")).map((h) => h.telegramMessageId)).toEqual(
      expect.arrayContaining([71, 72, 73]),
    );
    const videos = await search("door", { mediaKinds: ["video"] });
    expect(videos.map((h) => h.telegramMessageId)).toEqual([72]);
  });

  it("finds a message sent since the last indexing run", async () => {
    // The substring half reads `chat_messages` directly for exactly this reason:
    // a message minutes old has no index row yet, and a search that could not
    // find it would be a regression the other halves would hide.
    await recordIncomingMessage(
      { chatId: CHAT, telegramMessageId: 81, userId: ALEX, content: "the pizza was great", sentAt: new Date() },
      ctx.db,
    );
    const hits = await search("pizza");
    expect(hits.map((h) => h.telegramMessageId)).toEqual([81]);
    expect(hits[0].indexedContent).toBeNull();
  });

  it("never returns another chat's messages", async () => {
    await recordIncomingMessage(
      { chatId: "-1002", telegramMessageId: 91, userId: ALEX, content: "a door elsewhere", sentAt: new Date() },
      ctx.db,
    );
    await runMessageIndexing({}, ctx.db);
    expect(await search("door")).toEqual([]);
  });

  it("leaves nothing due once it has run", async () => {
    await seedDescribedPhoto({ telegramMessageId: 101, userId: BEA, description: "A blue front door." });
    await recordIncomingMessage(
      { chatId: CHAT, telegramMessageId: 102, userId: ALEX, content: "hello", sentAt: new Date() },
      ctx.db,
    );
    // An empty message is indexed too, rather than being handed back forever by
    // every scan.
    await seedMirrorMessage(ctx.db, { chatId: CHAT, telegramMessageId: 103 });

    expect(await countMessagesNeedingIndex(ctx.db)).toBe(3);
    await runMessageIndexing({}, ctx.db);
    expect(await countMessagesNeedingIndex(ctx.db)).toBe(0);

    const second = await runMessageIndexing({}, ctx.db);
    expect(second.indexed).toBe(0);
    expect(second.summary).toBe("index up to date");
  });
});
