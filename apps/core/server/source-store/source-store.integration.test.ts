import { fileURLToPath } from "node:url";

import { messageDedupeKey } from "@assistant-hub-swarm/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub-swarm/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StoreDb } from "@/server/store/db";

import * as storeSchema from "../../store/schema";
import {
  countEmbeddedSourceMessages,
  countSourceMessagesNeedingIndex,
  getSourceMessageSeries,
  getSourceTopUsers,
  listSourceChatDayCounts,
  listSourceMessagesNeedingIndex,
  replaceSourceSummariesForDay,
  searchSourceMessagesHybrid,
  searchSourceSummariesHybrid,
  upsertSourceMessageIndex,
} from "./content";
import {
  completeSourceFeedback,
  findAwaitingSourceFeedbackByMenu,
  listUnincorporatedSourceFeedbacks,
  markSourceFeedbackAwaitingText,
  setSourceFeedbackMenuMessage,
  upsertSourceFeedback,
} from "./feedbacks";
import {
  getSourceMediaByMessage,
  insertSourceMedia,
  listPendingSourceMediaRefs,
  markSourceMediaDescribed,
} from "./media";
import {
  appendSourceMessage,
  appendSourceMessagesBulk,
  filterMirroredMessageIds,
  getSourceMessagesSince,
  listChatAssistants,
  listSourceChatListings,
  upsertSourceChatActivity,
  upsertSourceUser,
  type ConversationScope,
} from "./repository";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/**
 * The generalized conversation store against a real Postgres: the stream
 * semantics (transport-computed dedupe keys, per-assistant DM scoping), the
 * media describe-then-drop lifecycle with the live-processing hold, the
 * hybrid search and index due-scan, summaries, analytics buckets, and the
 * feedback reopen rule — the behaviors the tg app's store suites proved,
 * re-homed with the data (redesign Phase 7).
 */

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("source_store");
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
    `TRUNCATE source_users, source_chats, source_chat_members, source_chat_assistants,
             source_messages, source_message_search, source_media, source_media_blobs,
             source_feedbacks, source_summaries RESTART IDENTITY CASCADE`,
  );
});

const GROUP = "-100200";
const DM = "777";

function groupScope(assistantId: string | null = null): ConversationScope {
  return { source: "tg", chatId: GROUP, assistantId, direct: false };
}

function dmScope(assistantId: string | null): ConversationScope {
  return { source: "tg", chatId: DM, assistantId, direct: true };
}

async function seedMessage(input: {
  chatId: string;
  assistantId?: string | null;
  sourceMessageId: string;
  role?: "user" | "assistant";
  userId?: string | null;
  content?: string;
  sentAt?: Date;
}) {
  return appendSourceMessage(
    {
      source: "tg",
      chatId: input.chatId,
      assistantId: input.assistantId ?? null,
      sourceMessageId: input.sourceMessageId,
      dedupeKey: messageDedupeKey({
        chatId: input.chatId,
        sourceMessageId: input.sourceMessageId,
        assistantId: input.chatId.startsWith("-") ? null : input.assistantId,
      }),
      role: input.role ?? "user",
      userId: input.userId ?? "42",
      content: input.content ?? "hello",
      replyToSourceMessageId: null,
      sentAt: input.sentAt ?? new Date(),
      processed: true,
    },
    db,
  );
}

describe("mirror + streams", () => {
  it("dedupes on the transport-computed key — a re-delivered update changes nothing", async () => {
    const first = await seedMessage({ chatId: GROUP, sourceMessageId: "10" });
    expect(first).not.toBeNull();
    const again = await seedMessage({ chatId: GROUP, sourceMessageId: "10" });
    expect(again).toBeNull();
  });

  it("keeps per-assistant DM streams apart and reads them scoped", async () => {
    // Two bots share the same DM chat id (the peer's user id); each numbers
    // its own messages — even the SAME message id must not collide.
    await seedMessage({ chatId: DM, assistantId: "anna", sourceMessageId: "5", content: "to anna" });
    await seedMessage({ chatId: DM, assistantId: "igor", sourceMessageId: "5", content: "to igor" });

    const anna = await getSourceMessagesSince(dmScope("anna"), new Date(0), {}, db);
    expect(anna.map((m) => m.content)).toEqual(["to anna"]);

    // The operator plane reads a DM unscoped: both streams.
    const unscoped = await getSourceMessagesSince(dmScope(null), new Date(0), {}, db);
    expect(unscoped).toHaveLength(2);
  });

  it("reads a group as one shared stream, every assistant's lines included", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "1", content: "human" });
    await seedMessage({
      chatId: GROUP,
      assistantId: "anna",
      sourceMessageId: "2",
      role: "assistant",
      userId: null,
      content: "anna's reply",
    });
    const forIgor = await getSourceMessagesSince(groupScope("igor"), new Date(0), {}, db);
    expect(forIgor.map((m) => m.content)).toEqual(["human", "anna's reply"]);
  });

  it("whitelists only mirrored ids for citation links", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "30" });
    const linkable = await filterMirroredMessageIds(groupScope(null), ["30", "31", "999"], db);
    expect(linkable).toEqual(["30"]);
  });

  it("bulk-imports into the shared stream, skipping rows that already exist", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "50", content: "already here" });
    const inserted = await appendSourceMessagesBulk(
      "tg",
      [
        {
          chatId: GROUP,
          sourceMessageId: "50",
          role: "user",
          userId: "42",
          content: "duplicate",
          replyToSourceMessageId: null,
          sentAt: new Date(),
          editedAt: null,
          deletedAt: null,
        },
        {
          chatId: GROUP,
          sourceMessageId: "51",
          role: "user",
          userId: "42",
          content: "new",
          replyToSourceMessageId: null,
          sentAt: new Date(),
          editedAt: null,
          deletedAt: null,
        },
      ],
      db,
    );
    expect(inserted).toBe(1);
  });
});

describe("directory + presence", () => {
  it("tracks users, chats, members and assistant presence from activity", async () => {
    await upsertSourceUser(
      { source: "tg", userId: "42", username: "someone", firstName: "Some", lastName: null },
      db,
    );
    await upsertSourceChatActivity(
      {
        source: "tg",
        chatId: GROUP,
        title: "The group",
        type: "supergroup",
        userId: "42",
        assistantId: "anna",
      },
      db,
    );
    expect(await listChatAssistants("tg", GROUP, db)).toEqual(["anna"]);

    await seedMessage({ chatId: GROUP, sourceMessageId: "1" });
    const listings = await listSourceChatListings("tg", db);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ chatId: GROUP, messageCount: 1, memberCount: 1 });
    expect(listings[0].chat?.title).toBe("The group");
  });
});

describe("media lifecycle", () => {
  it("stores pending frames, serves them, and drops the bytes on describe", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "70" });
    const stored = await insertSourceMedia(
      {
        id: "media-1",
        source: "tg",
        chatId: GROUP,
        sourceMessageId: "70",
        kind: "photo",
        fileId: "file-1",
        fileUniqueId: "uniq-1",
        mimeType: "image/jpeg",
        visionHint: null,
        frames: [Buffer.from("jpeg bytes").toString("base64")],
      },
      db,
    );
    expect(stored?.status).toBe("pending");
    expect(stored?.frames).toHaveLength(1);

    // The message is settled (processed), so the backfill may claim it.
    const refs = await listPendingSourceMediaRefs("tg", 10, db);
    expect(refs.map((ref) => ref.id)).toEqual(["media-1"]);

    const described = await markSourceMediaDescribed("media-1", "a cat on a chair", db);
    expect(described).toMatchObject({ status: "described", description: "a cat on a chair" });
    // Bytes are gone — the platform is its own archive.
    expect(described?.frames).toEqual([]);
    // A concurrent second pass loses.
    expect(await markSourceMediaDescribed("media-1", "something else", db)).toBeNull();

    const reread = await getSourceMediaByMessage("tg", GROUP, "70", db);
    expect(reread?.description).toBe("a cat on a chair");
  });

  it("keeps media of a live-held message out of the backfill's reach", async () => {
    await appendSourceMessage(
      {
        source: "tg",
        chatId: GROUP,
        assistantId: null,
        sourceMessageId: "71",
        dedupeKey: messageDedupeKey({ chatId: GROUP, sourceMessageId: "71" }),
        role: "user",
        userId: "42",
        content: "look",
        replyToSourceMessageId: null,
        sentAt: new Date(),
        processed: false,
      },
      db,
    );
    await insertSourceMedia(
      {
        id: "media-held",
        source: "tg",
        chatId: GROUP,
        sourceMessageId: "71",
        kind: "photo",
        fileId: "file-2",
        fileUniqueId: null,
        mimeType: "image/jpeg",
        visionHint: null,
        frames: [Buffer.from("x").toString("base64")],
      },
      db,
    );
    expect(await listPendingSourceMediaRefs("tg", 10, db)).toEqual([]);
  });
});

describe("search index + hybrid search", () => {
  it("scans due messages, indexes them, and finds them three ways", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "80", content: "the quick brown fox" });
    const due = await listSourceMessagesNeedingIndex("tg", 10, db);
    expect(due.map((row) => row.sourceMessageId)).toEqual(["80"]);
    expect(await countSourceMessagesNeedingIndex("tg", db)).toBe(1);

    await upsertSourceMessageIndex(
      "tg",
      [{ chatId: GROUP, sourceMessageId: "80", content: "the quick brown fox", embedding: null }],
      db,
    );
    expect(await countSourceMessagesNeedingIndex("tg", db)).toBe(0);
    expect(await countEmbeddedSourceMessages("tg", GROUP, db)).toBe(0);

    const matches = await searchSourceMessagesHybrid(
      "tg",
      { chatId: GROUP, queryText: "brown fox", queryVector: null, limit: 5 },
      db,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ sourceMessageId: "80", indexedContent: "the quick brown fox" });
  });

  it("answers a filters-only lookup with the most recent matches", async () => {
    await seedMessage({ chatId: GROUP, sourceMessageId: "90", userId: "42", content: "mine" });
    await seedMessage({ chatId: GROUP, sourceMessageId: "91", userId: "77", content: "theirs" });
    const matches = await searchSourceMessagesHybrid(
      "tg",
      {
        chatId: GROUP,
        queryText: "",
        queryVector: null,
        limit: 5,
        filters: { authorUserIds: ["42"] },
      },
      db,
    );
    expect(matches.map((m) => m.content)).toEqual(["mine"]);
  });
});

describe("summaries", () => {
  it("replaces a day's topics idempotently and searches them lexically", async () => {
    const first = await replaceSourceSummariesForDay(
      "tg",
      {
        chatId: GROUP,
        summaryDate: "2026-08-29",
        topics: [{ content: "planning the autumn trip", messageIds: ["1", "2"], embedding: null }],
      },
      db,
    );
    expect(first).toHaveLength(1);
    const replaced = await replaceSourceSummariesForDay(
      "tg",
      {
        chatId: GROUP,
        summaryDate: "2026-08-29",
        topics: [
          { content: "planning the autumn trip", messageIds: ["1", "2"], embedding: null },
          { content: "dinner plans", messageIds: ["3"], embedding: null },
        ],
      },
      db,
    );
    expect(replaced).toHaveLength(2);

    const matches = await searchSourceSummariesHybrid(
      "tg",
      { chatId: GROUP, queryText: "autumn trip", queryVector: null, limit: 5 },
      db,
    );
    expect(matches[0]).toMatchObject({ content: "planning the autumn trip", messageIds: ["1", "2"] });
  });
});

describe("analytics", () => {
  it("buckets message volume and finds top users", async () => {
    const at = new Date("2026-08-29T10:00:00Z");
    await seedMessage({ chatId: GROUP, sourceMessageId: "100", userId: "42", sentAt: at });
    await seedMessage({ chatId: GROUP, sourceMessageId: "101", userId: "42", sentAt: at });
    await seedMessage({
      chatId: GROUP,
      assistantId: "anna",
      sourceMessageId: "102",
      role: "assistant",
      userId: null,
      sentAt: at,
    });

    const series = await getSourceMessageSeries(
      "tg",
      {
        fromUtc: new Date("2026-08-29T00:00:00Z"),
        toUtc: new Date("2026-08-30T00:00:00Z"),
        unit: "day",
        timeZone: "UTC",
      },
      db,
    );
    expect(series).toEqual([{ bucket: "2026-08-29", human: 2, bot: 1, activeUsers: 1 }]);

    const top = await getSourceTopUsers(
      "tg",
      {
        fromUtc: new Date("2026-08-29T00:00:00Z"),
        toUtc: new Date("2026-08-30T00:00:00Z"),
        limit: 5,
      },
      db,
    );
    expect(top).toEqual([{ userId: "42", messages: 2 }]);

    const days = await listSourceChatDayCounts("tg", { timeZone: "UTC", before: "2026-09-01" }, db);
    expect(days).toEqual([{ chatId: GROUP, date: "2026-08-29", messageCount: 3 }]);
  });
});

describe("feedbacks", () => {
  it("runs the collect lifecycle and reopens on a repeat reaction", async () => {
    await upsertSourceUser(
      { source: "tg", userId: "42", username: null, firstName: null, lastName: null },
      db,
    );
    const created = await upsertSourceFeedback(
      { id: "fb-1", source: "tg", chatId: GROUP, sourceMessageId: "200", userId: "42", reaction: "up" },
      db,
    );
    expect(created).toMatchObject({ status: "pending", reaction: "up" });

    await setSourceFeedbackMenuMessage("fb-1", "300", db);
    await markSourceFeedbackAwaitingText("fb-1", db);
    const awaiting = await findAwaitingSourceFeedbackByMenu("tg", GROUP, "300", "42", db);
    expect(awaiting?.id).toBe("fb-1");

    const completed = await completeSourceFeedback("fb-1", "great memory recall", "quality", db);
    expect(completed).toMatchObject({ status: "completed", feedback: "great memory recall" });
    expect(await listUnincorporatedSourceFeedbacks("prefs", db)).toHaveLength(1);

    // A repeat reaction reopens the SAME row: fresh answer wanted.
    const reopened = await upsertSourceFeedback(
      {
        id: "fb-ignored",
        source: "tg",
        chatId: GROUP,
        sourceMessageId: "200",
        userId: "42",
        reaction: "down",
      },
      db,
    );
    expect(reopened).toMatchObject({
      id: "fb-1",
      reaction: "down",
      status: "pending",
      feedback: null,
      menuMessageId: null,
    });
  });
});
