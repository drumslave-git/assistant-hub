import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import {
  fromColumn,
  fromConstant,
  guessMapping,
  parseCsv,
  HISTORY_CSV_HEADERS,
  type ColumnMapping,
} from "../csv";
import { getChatHistory, recordAssistantMessage, recordIncomingMessage } from "./service";
import { exportHistoryCsv, importHistoryCsv } from "./transfer";

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

const trigger = { kind: "dashboard" } as const;
const SENT = new Date("2026-07-14T10:00:00.000Z");

/** The identity mapping an exported file auto-detects. */
const CANONICAL: ColumnMapping = guessMapping(HISTORY_CSV_HEADERS);

async function seedConversation() {
  await recordIncomingMessage(
    { chatId: "5", telegramMessageId: 1, userId: "100", content: "hello", sentAt: SENT },
    ctx.db,
  );
  await recordAssistantMessage(
    {
      chatId: "5",
      telegramMessageId: 2,
      content: 'hi — "quoted", multi\nline',
      replyToMessageId: 1,
      sentAt: new Date("2026-07-14T10:00:05.000Z"),
    },
    ctx.db,
  );
  await recordIncomingMessage(
    { chatId: "-1009", telegramMessageId: 8, userId: "200", content: "group chatter", sentAt: SENT },
    ctx.db,
  );
}

describe("exportHistoryCsv", () => {
  it("exports every chat with the canonical header", async () => {
    await seedConversation();
    const table = parseCsv(await exportHistoryCsv(undefined, ctx.db));
    expect(table.headers).toEqual(HISTORY_CSV_HEADERS);
    expect(table.rows).toHaveLength(3);
    expect(guessMapping(table.headers)).toEqual(CANONICAL);
  });

  it("scopes to one chat when asked", async () => {
    await seedConversation();
    const table = parseCsv(await exportHistoryCsv("5", ctx.db));
    expect(table.rows).toHaveLength(2);
    expect(table.rows.every((row) => row[0] === "5")).toBe(true);
  });

  it("exports a header-only file when the mirror is empty", async () => {
    const table = parseCsv(await exportHistoryCsv(undefined, ctx.db));
    expect(table.headers).toEqual(HISTORY_CSV_HEADERS);
    expect(table.rows).toEqual([]);
  });
});

describe("importHistoryCsv", () => {
  it("round-trips an export back into an empty mirror, preserving every field", async () => {
    await seedConversation();
    const csv = await exportHistoryCsv(undefined, ctx.db);
    await ctx.truncate();

    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger, ctx.db);
    expect(result).toMatchObject({
      totalRows: 3,
      imported: 3,
      skippedDuplicates: 0,
      errors: [],
    });
    expect(result.chatIds).toEqual(["-1009", "5"]);

    const restored = await getChatHistory("5", {}, ctx.db);
    expect(restored).toHaveLength(2);
    expect(restored.find((m) => m.telegramMessageId === 2)).toMatchObject({
      role: "assistant",
      userId: null,
      content: 'hi — "quoted", multi\nline',
      replyToMessageId: 1,
    });
    expect(restored.find((m) => m.telegramMessageId === 1)).toMatchObject({
      role: "user",
      userId: "100",
      content: "hello",
    });
  });

  it("skips messages already stored instead of duplicating or overwriting them", async () => {
    await seedConversation();
    const csv = await exportHistoryCsv("5", ctx.db);

    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger, ctx.db);
    expect(result).toMatchObject({ totalRows: 2, imported: 0, skippedDuplicates: 2 });
    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(2);

    // A second run of a file with one new row imports only that row.
    const mixed =
      `${HISTORY_CSV_HEADERS.join(",")}\n` +
      `5,1,user,hello,2026-07-14T10:00:00.000Z,100,,,\n` +
      `5,3,user,brand new,2026-07-14T11:00:00.000Z,100,,,\n`;
    const second = await importHistoryCsv({ csv: mixed, mapping: CANONICAL }, trigger, ctx.db);
    expect(second).toMatchObject({ totalRows: 2, imported: 1, skippedDuplicates: 1 });
    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(3);
  });

  it("imports a foreign CSV through an operator column mapping", async () => {
    const csv =
      "Conversation,MsgId,Who,Text,When,Author\n" +
      "777,10,human,imported question,1768392000,900\n" +
      "777,11,bot,imported answer,2026-07-14T10:00:10Z,\n";
    const result = await importHistoryCsv(
      {
        csv,
        mapping: {
          chat_id: fromColumn("Conversation"),
          telegram_message_id: fromColumn("MsgId"),
          role: fromColumn("Who"),
          content: fromColumn("Text"),
          sent_at: fromColumn("When"),
          user_id: fromColumn("Author"),
        },
      },
      trigger,
      ctx.db,
    );
    expect(result).toMatchObject({ imported: 2, skippedDuplicates: 0, errors: [] });

    const restored = await getChatHistory("777", {}, ctx.db);
    expect(restored.map((m) => ({ role: m.role, content: m.content, userId: m.userId }))).toEqual([
      { role: "assistant", content: "imported answer", userId: null },
      { role: "user", content: "imported question", userId: "900" },
    ]);
  });

  it("imports the valid rows and reports the invalid ones per line", async () => {
    const csv =
      `${HISTORY_CSV_HEADERS.join(",")}\n` +
      `5,1,user,good,2026-07-14T10:00:00Z,100,,,\n` +
      `5,nope,user,bad id,2026-07-14T10:00:00Z,100,,,\n` +
      `5,3,alien,bad role,2026-07-14T10:00:00Z,100,,,\n`;
    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger, ctx.db);
    expect(result).toMatchObject({ totalRows: 3, imported: 1, skippedDuplicates: 0 });
    expect(result.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(1);
  });

  it("fills columns the file lacks with fixed values applied to every row", async () => {
    // A per-chat export: message id, text and time only — no chat, role or sender.
    const csv =
      "mid,body,when\n" +
      "1,first,2026-07-14T10:00:00Z\n" +
      "2,second,2026-07-14T10:01:00Z\n";
    const result = await importHistoryCsv(
      {
        csv,
        mapping: {
          telegram_message_id: fromColumn("mid"),
          content: fromColumn("body"),
          sent_at: fromColumn("when"),
          chat_id: fromConstant("-1001234567890"),
          role: fromConstant("human"),
          user_id: fromConstant("900"),
        },
      },
      trigger,
      ctx.db,
    );
    expect(result).toMatchObject({ imported: 2, skippedDuplicates: 0, errors: [] });
    expect(result.chatIds).toEqual(["-1001234567890"]);

    const restored = await getChatHistory("-1001234567890", {}, ctx.db);
    expect(restored.map((m) => ({ role: m.role, userId: m.userId, content: m.content }))).toEqual([
      { role: "user", userId: "900", content: "second" },
      { role: "user", userId: "900", content: "first" },
    ]);
  });

  it("rejects an unusable fixed value, and a fixed message id, before writing anything", async () => {
    const csv = "mid,body,when\n1,first,2026-07-14T10:00:00Z\n";
    const base = {
      telegram_message_id: fromColumn("mid"),
      content: fromColumn("body"),
      sent_at: fromColumn("when"),
      chat_id: fromConstant("5"),
      role: fromConstant("user"),
    };

    await expect(
      importHistoryCsv({ csv, mapping: { ...base, role: fromConstant("alien") } }, trigger, ctx.db),
    ).rejects.toThrow(/role must be user or assistant/);

    // The unique key can never be a fixed value — every row would collapse into one.
    await expect(
      importHistoryCsv(
        { csv, mapping: { ...base, telegram_message_id: fromConstant("7") } },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/must come from a column/);

    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(0);
  });

  it("rejects a file with an unmapped required column, an empty file, and an all-invalid file", async () => {
    const csv = `${HISTORY_CSV_HEADERS.join(",")}\n5,1,user,x,2026-07-14T10:00:00Z,,,,\n`;
    await expect(
      importHistoryCsv({ csv, mapping: { chat_id: fromColumn("chat_id") } }, trigger, ctx.db),
    ).rejects.toThrow(/Unmapped required column/);

    await expect(
      importHistoryCsv({ csv: HISTORY_CSV_HEADERS.join(","), mapping: CANONICAL }, trigger, ctx.db),
    ).rejects.toThrow(/no data rows/);

    const allBad = `${HISTORY_CSV_HEADERS.join(",")}\n5,x,user,bad,not-a-date,,,,\n`;
    await expect(
      importHistoryCsv({ csv: allBad, mapping: CANONICAL }, trigger, ctx.db),
    ).rejects.toThrow(/No valid rows/);

    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(0);
  });

  it("traces the import under the history feature, with the mapping and outcome", async () => {
    const csv = `${HISTORY_CSV_HEADERS.join(",")}\n5,1,user,traced,2026-07-14T10:00:00Z,100,,,\n`;
    await importHistoryCsv({ csv, mapping: CANONICAL }, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "history" });
    expect(traces[0]).toMatchObject({ feature: "history", action: "import", status: "success" });
    expect(traces[0].outputSummary).toContain("imported 1");
  });

  it("records a failed import as a failed trace", async () => {
    await expect(
      importHistoryCsv({ csv: "a,b\n1,2\n", mapping: {} }, trigger, ctx.db),
    ).rejects.toThrow();
    const { traces } = await listTraces({ feature: "history" });
    expect(traces[0]).toMatchObject({ action: "import", status: "error" });
  });
});
