import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../store/schema";
import { appendMessage, markMessageDeleted } from "../store";
import {
  getMessageAvailability,
  getMessageSeries,
  getNewUserSeries,
  getTopUsers,
  listChatHourCounts,
} from "./analytics";
import { listChatSummaries, replaceSummariesForDay } from "./summaries";

const MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/**
 * The analytics aggregation SQL (the swap's last content-plane piece),
 * pinned against a real Postgres: wall-clock bucketing in a timezone,
 * role splits, half-open ranges, deleted-row exclusion, and the hour-count
 * due-scan half. The core-side card/insight logic runs over the in-memory
 * fake of this contract; the bucket semantics live HERE (ported from the
 * v1 analytics suite).
 */

describe("tg analytics aggregates", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_analytics");
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
      `TRUNCATE messages, media, media_blobs, users RESTART IDENTITY CASCADE`,
    );
  });

  async function mirror(input: {
    chatId?: string;
    id: number;
    role?: "user" | "assistant";
    userId?: string | null;
    sentAt: Date;
  }) {
    return appendMessage(db, {
      chatId: input.chatId ?? "-500",
      telegramMessageId: input.id,
      role: input.role ?? "user",
      userId:
        input.userId !== undefined ? input.userId : (input.role ?? "user") === "user" ? "100" : null,
      content: `message ${input.id}`,
      replyToMessageId: null,
      sentAt: input.sentAt,
      processed: true,
    });
  }

  const JULY_RANGE = {
    fromUtc: new Date("2026-07-15T00:00:00Z"),
    toUtc: new Date("2026-07-16T00:00:00Z"),
  };

  describe("message series", () => {
    it("buckets by wall-clock hour in the requested timezone, split by role", async () => {
      // 09:30 UTC is 12:30 in Europe/Athens (UTC+3 in July).
      await mirror({ id: 1, sentAt: new Date("2026-07-15T09:30:00Z") });
      await mirror({ id: 2, role: "assistant", sentAt: new Date("2026-07-15T09:31:00Z") });

      const utc = await getMessageSeries(db, { ...JULY_RANGE, unit: "hour", timeZone: "UTC" });
      const athens = await getMessageSeries(db, {
        ...JULY_RANGE,
        unit: "hour",
        timeZone: "Europe/Athens",
      });

      expect(utc).toEqual([{ bucket: "2026-07-15 09", human: 1, bot: 1, activeUsers: 1 }]);
      expect(athens).toEqual([{ bucket: "2026-07-15 12", human: 1, bot: 1, activeUsers: 1 }]);
    });

    it("counts distinct human senders as active users and honours the scope filters", async () => {
      await mirror({ id: 1, userId: "1", sentAt: new Date("2026-07-15T10:00:00Z") });
      await mirror({ id: 2, userId: "1", sentAt: new Date("2026-07-15T10:05:00Z") });
      await mirror({ id: 3, userId: "2", sentAt: new Date("2026-07-15T10:10:00Z") });
      await mirror({ chatId: "-600", id: 4, userId: "3", sentAt: new Date("2026-07-15T10:15:00Z") });

      const all = await getMessageSeries(db, { ...JULY_RANGE, unit: "day", timeZone: "UTC" });
      expect(all).toEqual([{ bucket: "2026-07-15", human: 4, bot: 0, activeUsers: 3 }]);

      const oneChat = await getMessageSeries(db, {
        ...JULY_RANGE,
        unit: "day",
        timeZone: "UTC",
        chatId: "-500",
      });
      expect(oneChat[0]).toMatchObject({ human: 3, activeUsers: 2 });

      const oneUser = await getMessageSeries(db, {
        ...JULY_RANGE,
        unit: "day",
        timeZone: "UTC",
        userId: "1",
      });
      expect(oneUser[0]).toMatchObject({ human: 2, activeUsers: 1 });
    });

    it("treats the range as half-open and skips deleted rows", async () => {
      await mirror({ id: 1, sentAt: new Date("2026-07-15T00:00:00Z") });
      await mirror({ id: 2, sentAt: new Date("2026-07-16T00:00:00Z") });
      await mirror({ id: 3, sentAt: new Date("2026-07-15T10:00:00Z") });
      await markMessageDeleted(db, "-500", 3);

      const rows = await getMessageSeries(db, { ...JULY_RANGE, unit: "all", timeZone: "UTC" });
      expect(rows).toEqual([{ bucket: "all", human: 1, bot: 0, activeUsers: 1 }]);
    });
  });

  it("buckets first sightings for the new-user series", async () => {
    await db.insert(schema.users).values([
      { userId: "1", firstSeenAt: new Date("2026-07-15T10:00:00Z") },
      { userId: "2", firstSeenAt: new Date("2026-07-15T11:00:00Z") },
      { userId: "3", firstSeenAt: new Date("2026-08-01T00:00:00Z") },
    ]);

    const rows = await getNewUserSeries(db, { ...JULY_RANGE, unit: "day", timeZone: "UTC" });
    expect(rows).toEqual([{ bucket: "2026-07-15", newUsers: 2 }]);
  });

  it("ranks top users by message count, humans only, capped", async () => {
    for (let i = 1; i <= 3; i += 1) {
      await mirror({ id: i, userId: "7", sentAt: new Date("2026-07-15T10:00:00Z") });
    }
    await mirror({ id: 4, userId: "8", sentAt: new Date("2026-07-15T10:00:00Z") });
    await mirror({ id: 5, role: "assistant", sentAt: new Date("2026-07-15T10:00:00Z") });

    const rows = await getTopUsers(db, { ...JULY_RANGE, limit: 1 });
    expect(rows).toEqual([{ userId: "7", messages: 3 }]);
  });

  it("marks exactly the buckets holding messages as available", async () => {
    await mirror({ id: 1, sentAt: new Date("2026-07-15T10:00:00Z") });
    await mirror({ id: 2, sentAt: new Date("2026-07-02T10:00:00Z") });

    const buckets = await getMessageAvailability(db, {
      fromUtc: new Date("2026-07-01T00:00:00Z"),
      toUtc: new Date("2026-08-01T00:00:00Z"),
      unit: "day",
      timeZone: "UTC",
    });
    expect(buckets).toEqual(["2026-07-02", "2026-07-15"]);
  });

  describe("hour counts (the insight due-scan half)", () => {
    it("groups visible messages per (chat, wall-clock hour), ordered oldest first", async () => {
      await mirror({ id: 1, sentAt: new Date("2026-07-15T09:10:00Z") });
      await mirror({ id: 2, sentAt: new Date("2026-07-15T09:50:00Z") });
      await mirror({ chatId: "-600", id: 3, sentAt: new Date("2026-07-14T20:00:00Z") });
      await mirror({ id: 4, sentAt: new Date("2026-07-15T09:55:00Z") });
      await markMessageDeleted(db, "-500", 4);

      const hours = await listChatHourCounts(db, { timeZone: "UTC" });
      expect(hours).toEqual([
        { chatId: "-600", insightHour: "2026-07-14 20", messageCount: 1 },
        { chatId: "-500", insightHour: "2026-07-15 09", messageCount: 2 },
      ]);
    });

    it("bounds the scan at the floor instant", async () => {
      await mirror({ id: 1, sentAt: new Date("2026-07-10T09:00:00Z") });
      await mirror({ id: 2, sentAt: new Date("2026-07-15T09:00:00Z") });

      const hours = await listChatHourCounts(db, {
        timeZone: "UTC",
        fromUtc: new Date("2026-07-14T00:00:00Z"),
      });
      expect(hours).toEqual([
        { chatId: "-500", insightHour: "2026-07-15 09", messageCount: 1 },
      ]);
    });
  });

  it("restricts a summaries listing to one day when asked", async () => {
    await replaceSummariesForDay(db, {
      chatId: "-500",
      summaryDate: "2026-07-15",
      topics: [{ content: "the trip", messageIds: [1], embedding: null }],
    });
    await replaceSummariesForDay(db, {
      chatId: "-500",
      summaryDate: "2026-07-16",
      topics: [{ content: "the recap", messageIds: [2], embedding: null }],
    });

    const day = await listChatSummaries(db, "-500", 200, "2026-07-15");
    expect(day.map((s) => s.content)).toEqual(["the trip"]);
    expect(await listChatSummaries(db, "-500")).toHaveLength(2);
  });
});
