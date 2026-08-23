import { fileURLToPath } from "node:url";

import { EMBEDDING_DIMENSIONS } from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../store/schema";
import { insertMedia } from "../media/store";
import { appendMessage, markMessageDeleted } from "../store";
import {
  clearMessageIndex,
  countEmbeddedMessages,
  countMessagesNeedingIndex,
  listMessagesNeedingIndex,
  upsertMessageIndex,
} from "./index-store";
import { searchMessagesHybrid, searchSummariesHybrid } from "./search";
import {
  countSummariesByChat,
  listChatDayCounts,
  listChatSummaries,
  replaceSummariesForDay,
} from "./summaries";

const MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/**
 * The conversation-content SQL that moved here with the swap — hybrid
 * search, the index due-scan, summaries, day buckets — exercised against a
 * real Postgres with the store's real indexes. The core-side job logic runs
 * over an in-memory fake of this contract; THIS file is where the search
 * and scan semantics themselves are pinned (ported from the v1 core
 * history suites).
 */

describe("tg content store", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_content");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE messages, message_search, media, media_blobs, summaries RESTART IDENTITY CASCADE`,
    );
  });

  async function mirror(input: {
    chatId?: string;
    id: number;
    content?: string;
    userId?: string | null;
    role?: "user" | "assistant";
    sentAt?: Date;
  }) {
    return appendMessage(db, {
      chatId: input.chatId ?? "-500",
      telegramMessageId: input.id,
      role: input.role ?? "user",
      userId: input.userId !== undefined ? input.userId : "100",
      content: input.content ?? `message ${input.id}`,
      replyToMessageId: null,
      sentAt: input.sentAt ?? new Date(),
      processed: true,
    });
  }

  async function indexRow(input: {
    chatId?: string;
    id: number;
    content: string;
    embedding?: number[] | null;
  }) {
    await upsertMessageIndex(db, [
      {
        chatId: input.chatId ?? "-500",
        telegramMessageId: input.id,
        content: input.content,
        embedding: input.embedding ?? null,
      },
    ]);
  }

  /** A synthetic embedding: 1 at `axis`, 0 elsewhere. */
  function basis(axis: number): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[axis] = 1;
    return vector;
  }

  describe("searchMessagesHybrid", () => {
    it("finds an uncaptioned photo by what the picture shows (the indexed text)", async () => {
      await mirror({ id: 1, content: "" });
      await indexRow({ id: 1, content: "[photo: a weathered blue front door]" });
      await mirror({ id: 2, content: "unrelated chatter" });

      const matches = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "blue door",
        queryVector: null,
        limit: 10,
      });
      expect(matches.map((m) => m.telegramMessageId)).toEqual([1]);
      expect(matches[0].indexedContent).toContain("blue front door");
    });

    it("matches content case-insensitively, excludes other chats, and caps at the limit", async () => {
      for (let id = 1; id <= 5; id += 1) {
        await mirror({ id, content: `Pizza night number ${id}` });
      }
      await mirror({ chatId: "-501", id: 9, content: "pizza elsewhere" });

      const matches = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "PIZZA",
        queryVector: null,
        limit: 3,
      });
      expect(matches).toHaveLength(3);
      expect(matches.every((m) => m.chatId === "-500")).toBe(true);
    });

    it("treats LIKE metacharacters as literals", async () => {
      await mirror({ id: 1, content: "progress: 100%_done" });
      await mirror({ id: 2, content: "progress: fully done" });

      const matches = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "100%_done",
        queryVector: null,
        limit: 10,
      });
      expect(matches.map((m) => m.telegramMessageId)).toEqual([1]);
    });

    it("ranks by the vector half when a query embedding is given", async () => {
      await mirror({ id: 1, content: "first" });
      await mirror({ id: 2, content: "second" });
      await indexRow({ id: 1, content: "first", embedding: basis(0) });
      await indexRow({ id: 2, content: "second", embedding: basis(1) });

      const matches = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "zzz-nothing-lexical",
        queryVector: basis(1),
        limit: 2,
      });
      expect(matches[0].telegramMessageId).toBe(2);
    });

    it("narrows by author and by media kind, and answers filters-only lookups", async () => {
      await mirror({ id: 1, content: "from alice", userId: "100" });
      await mirror({ id: 2, content: "from bob", userId: "200" });
      await mirror({ id: 3, content: "", userId: "200" });
      await insertMedia(db, {
        id: "m-3",
        chatId: "-500",
        telegramMessageId: 3,
        kind: "photo",
        fileId: "f3",
        fileUniqueId: null,
        mimeType: "image/jpeg",
        visionHint: null,
        frames: [],
      });

      const byAuthor = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "from",
        queryVector: null,
        limit: 10,
        filters: { authorUserIds: ["200"] },
      });
      expect(byAuthor.map((m) => m.telegramMessageId)).toEqual([2]);

      // Filters with no query at all — "the photos she sent" — answer with
      // the most recent matches instead of nothing (v1 lesson, 2026-08-07).
      const photosOnly = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "",
        queryVector: null,
        limit: 10,
        filters: { mediaKinds: ["photo"] },
      });
      expect(photosOnly.map((m) => m.telegramMessageId)).toEqual([3]);
      expect(photosOnly[0].mediaKind).toBe("photo");

      // Neither query nor filters: nothing to rank by, nothing returned.
      const nothing = await searchMessagesHybrid(db, {
        chatId: "-500",
        queryText: "",
        queryVector: null,
        limit: 10,
      });
      expect(nothing).toEqual([]);
    });

    it("searches every chat when given none, and never returns deleted rows", async () => {
      await mirror({ chatId: "-500", id: 1, content: "the shared word" });
      await mirror({ chatId: "-501", id: 2, content: "the shared word too" });
      await mirror({ chatId: "-501", id: 3, content: "the shared word, deleted" });
      await markMessageDeleted(db, "-501", 3);

      const matches = await searchMessagesHybrid(db, {
        chatId: null,
        queryText: "shared word",
        queryVector: null,
        limit: 10,
      });
      expect(matches.map((m) => m.telegramMessageId).sort()).toEqual([1, 2]);
    });
  });

  describe("index due-scan", () => {
    it("owes work on unindexed rows, and re-owes when a description or edit lands later", async () => {
      await mirror({ id: 1, content: "plain" });
      await mirror({ id: 2, content: "" });
      await insertMedia(db, {
        id: "m-2",
        chatId: "-500",
        telegramMessageId: 2,
        kind: "photo",
        fileId: "f2",
        fileUniqueId: null,
        mimeType: "image/jpeg",
        visionHint: null,
        frames: ["QUJD"],
      });

      expect(await countMessagesNeedingIndex(db)).toBe(2);
      const due = await listMessagesNeedingIndex(db, 10);
      expect(due.map((m) => m.telegramMessageId)).toEqual([1, 2]);
      expect(due[1].media).toMatchObject({ kind: "photo", status: "pending" });

      await upsertMessageIndex(db, [
        { chatId: "-500", telegramMessageId: 1, content: "plain", embedding: null },
        { chatId: "-500", telegramMessageId: 2, content: "[photo]", embedding: null },
      ]);
      expect(await countMessagesNeedingIndex(db)).toBe(0);

      // The photo's description arrives later (the backfill) — the row is
      // due again so the index can finally say what the picture shows.
      await pool.query(
        // The interval guards against host/container clock skew: strictly
        // later than the row's indexed_at is what the scan compares.
        `UPDATE media SET status = 'described', description = 'a red bike', described_at = now() + interval '1 minute' WHERE id = 'm-2'`,
      );
      expect((await listMessagesNeedingIndex(db, 10)).map((m) => m.telegramMessageId)).toEqual([2]);

      await upsertMessageIndex(db, [
        { chatId: "-500", telegramMessageId: 2, content: "[photo: a red bike]", embedding: null },
      ]);
      // The skew-guard interval above outruns the fresh row's indexed_at;
      // settle it explicitly so only the edit below re-dues anything.
      await pool.query(
        `UPDATE message_search SET indexed_at = now() + interval '2 minutes' WHERE telegram_message_id = 2`,
      );
      // An edit re-dues too.
      await pool.query(
        `UPDATE messages SET edited_at = now() + interval '3 minutes', content = 'edited' WHERE telegram_message_id = 1`,
      );
      expect((await listMessagesNeedingIndex(db, 10)).map((m) => m.telegramMessageId)).toEqual([1]);
    });

    it("never owes work on deleted rows, upserts replace, clear counts, embedded counts", async () => {
      await mirror({ id: 1, content: "gone" });
      await markMessageDeleted(db, "-500", 1);
      expect(await countMessagesNeedingIndex(db)).toBe(0);

      await mirror({ id: 2, content: "kept" });
      await upsertMessageIndex(db, [
        { chatId: "-500", telegramMessageId: 2, content: "kept", embedding: null },
      ]);
      await upsertMessageIndex(db, [
        { chatId: "-500", telegramMessageId: 2, content: "kept v2", embedding: basis(0) },
      ]);
      const rows = await pool.query(`SELECT content FROM message_search`);
      expect(rows.rows).toEqual([{ content: "kept v2" }]);
      expect(await countEmbeddedMessages(db, "-500")).toBe(1);

      expect(await clearMessageIndex(db)).toBe(1);
      expect(await countMessagesNeedingIndex(db)).toBe(1);
    });
  });

  describe("summaries", () => {
    it("replaces a day's topics idempotently and lists newest day first", async () => {
      await replaceSummariesForDay(db, {
        chatId: "-500",
        summaryDate: "2026-08-01",
        topics: [
          { content: "planned the trip", messageIds: [1, 2], embedding: null },
          { content: "argued about pizza", messageIds: [3], embedding: null },
        ],
      });
      // A re-run replaces rather than duplicates.
      const replaced = await replaceSummariesForDay(db, {
        chatId: "-500",
        summaryDate: "2026-08-01",
        topics: [{ content: "planned the trip properly", messageIds: [1, 2, 3], embedding: null }],
      });
      expect(replaced).toHaveLength(1);
      await replaceSummariesForDay(db, {
        chatId: "-500",
        summaryDate: "2026-08-02",
        topics: [{ content: "settled on pepperoni", messageIds: [9], embedding: basis(2) }],
      });

      const listed = await listChatSummaries(db, "-500");
      expect(listed.map((s) => s.summaryDate)).toEqual(["2026-08-02", "2026-08-01"]);
      expect(listed[0].embedded).toBe(true);
      expect(listed[1]).toMatchObject({
        content: "planned the trip properly",
        messageIds: [1, 2, 3],
        embedded: false,
      });
      expect(await countSummariesByChat(db)).toEqual(new Map([["-500", 2]]));
    });

    it("finds a topic by wording (full text) with no vector at all", async () => {
      await replaceSummariesForDay(db, {
        chatId: "-500",
        summaryDate: "2026-08-01",
        topics: [
          { content: "The group planned a hiking trip to the mountains", messageIds: [1], embedding: null },
          { content: "Someone shared a soup recipe", messageIds: [2], embedding: null },
        ],
      });
      const matches = await searchSummariesHybrid(db, {
        chatId: "-500",
        queryText: "hiking trip",
        queryVector: null,
        limit: 5,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].content).toContain("hiking");
    });
  });

  describe("day counts", () => {
    it("buckets by the requested wall clock and excludes today and deleted rows", async () => {
      // 23:30 UTC on the 1st is already the 2nd in a +02:00 zone.
      await mirror({ id: 1, sentAt: new Date("2026-08-01T23:30:00Z") });
      await mirror({ id: 2, sentAt: new Date("2026-08-01T10:00:00Z") });
      await mirror({ id: 3, sentAt: new Date("2026-08-02T10:00:00Z") });
      await mirror({ id: 4, sentAt: new Date("2026-08-02T11:00:00Z") });
      await markMessageDeleted(db, "-500", 4);

      const days = await listChatDayCounts(db, { timeZone: "Europe/Kyiv", before: "2026-08-03" });
      expect(days).toEqual([
        { chatId: "-500", date: "2026-08-01", messageCount: 1 },
        { chatId: "-500", date: "2026-08-02", messageCount: 2 },
      ]);

      // `before` fences the unfinished day out entirely.
      const fenced = await listChatDayCounts(db, { timeZone: "Europe/Kyiv", before: "2026-08-02" });
      expect(fenced).toEqual([{ chatId: "-500", date: "2026-08-01", messageCount: 1 }]);
    });
  });
});
