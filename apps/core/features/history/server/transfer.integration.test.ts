import { parseScopedRef } from "@assistant-hub-swarm/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { listTraces } from "@/server/trace";
import { fakeSourceContent, type FakeSourceContent } from "@/test/fake-source-content";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { registerTestTransport } from "@/test/transports";
import {
  fromColumn,
  fromConstant,
  guessMapping,
  parseCsv,
  HISTORY_CSV_HEADERS,
  type ColumnMapping,
} from "../csv";
import { exportHistoryCsv, importHistoryCsv } from "./transfer";

/**
 * CSV transfer over the source-owned mirror: export reads and import writes
 * through the content client (the in-memory fake here; the tg internal API
 * live), with the parsing/mapping/validation — this side's whole job —
 * exercised for real. Traces land in the real store.
 */

// The mirror lives with the owning source; both directions go through it.
let content: FakeSourceContent;
const holder = vi.hoisted(() => ({ db: null as unknown }));

// Production code that walks the registered transports reads the default
// store handle; point it at this suite's container.
vi.mock("@/server/store/db", () => ({
  getStoreDb: () => holder.db,
  getStorePool: () => {
    throw new Error("not used in this suite");
  },
  closeStorePool: async () => {},
}));

vi.mock("@/server/source/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/source/content")>();
  return { ...actual, requireSourceContent: () => content };
});
vi.mock("@/server/source-store/directory-client", () => ({
  sourceDirectoryClient: () => ({
    listChats: async () => {
      const ids = [...new Set(content.rows.map((row) => parseScopedRef(row.chatRef).id))];
      return ids.map((id) => ({
        id,
        kind: id.startsWith("-") ? "group" : "direct",
        title: null,
        type: null,
        notes: null,
        language: null,
        messageCount: content.rows.filter((row) => parseScopedRef(row.chatRef).id === id).length,
        lastMessageAt: new Date().toISOString(),
      }));
    },
  }),
}));

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
  holder.db = ctx.db;
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  await registerTestTransport(ctx.db);
  content = fakeSourceContent();
});

const trigger = { kind: "dashboard" } as const;
const SENT = new Date("2026-07-14T10:00:00.000Z");

/** The identity mapping an exported file auto-detects. */
const CANONICAL: ColumnMapping = guessMapping(HISTORY_CSV_HEADERS);

function seedConversation() {
  content.addMessage({
    chatRef: "tg:chat:5",
    sourceMessageId: "1",
    userId: "100",
    content: "hello",
    sentAt: SENT,
  });
  content.addMessage({
    chatRef: "tg:chat:5",
    sourceMessageId: "2",
    role: "assistant",
    content: 'hi — "quoted", multi\nline',
    replyToSourceMessageId: "1",
    sentAt: new Date("2026-07-14T10:00:05.000Z"),
  });
  content.addMessage({
    chatRef: "tg:chat:-1009",
    sourceMessageId: "8",
    userId: "200",
    content: "group chatter",
    sentAt: SENT,
  });
}

async function chatRows(chatRef: string) {
  return content.allMessages(chatRef);
}

describe("exportHistoryCsv", () => {
  it("exports every chat with the canonical header", async () => {
    seedConversation();
    const table = parseCsv(await exportHistoryCsv());
    expect(table.headers).toEqual(HISTORY_CSV_HEADERS);
    expect(table.rows).toHaveLength(3);
    expect(guessMapping(table.headers)).toEqual(CANONICAL);
  });

  it("scopes to one chat when asked", async () => {
    seedConversation();
    const table = parseCsv(await exportHistoryCsv("tg:chat:5"));
    expect(table.rows).toHaveLength(2);
    expect(table.rows.every((row) => row[0] === "tg:chat:5")).toBe(true);
  });

  it("exports a header-only file when the mirror is empty", async () => {
    const table = parseCsv(await exportHistoryCsv());
    expect(table.headers).toEqual(HISTORY_CSV_HEADERS);
    expect(table.rows).toEqual([]);
  });
});

describe("importHistoryCsv", () => {
  it("round-trips an export back into an empty mirror, preserving every field", async () => {
    seedConversation();
    const csv = await exportHistoryCsv();
    content = fakeSourceContent(); // a fresh, empty mirror

    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger);
    expect(result).toMatchObject({
      totalRows: 3,
      imported: 3,
      skippedDuplicates: 0,
      errors: [],
    });
    expect(result.chatRefs).toEqual(["tg:chat:-1009", "tg:chat:5"]);

    const restored = await chatRows("tg:chat:5");
    expect(restored).toHaveLength(2);
    expect(restored.find((m) => m.sourceMessageId === "2")).toMatchObject({
      role: "assistant",
      userId: null,
      content: 'hi — "quoted", multi\nline',
      replyToSourceMessageId: "1",
    });
    expect(restored.find((m) => m.sourceMessageId === "1")).toMatchObject({
      role: "user",
      userId: "100",
      content: "hello",
    });
  });

  it("skips messages already stored instead of duplicating or overwriting them", async () => {
    seedConversation();
    const csv = await exportHistoryCsv("tg:chat:5");

    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger);
    expect(result).toMatchObject({ totalRows: 2, imported: 0, skippedDuplicates: 2 });
    expect(await chatRows("tg:chat:5")).toHaveLength(2);

    // A second run of a file with one new row imports only that row.
    const mixed =
      `${HISTORY_CSV_HEADERS.join(",")}\n` +
      `tg:chat:5,1,user,hello,2026-07-14T10:00:00.000Z,100,,,\n` +
      `tg:chat:5,3,user,brand new,2026-07-14T11:00:00.000Z,100,,,\n`;
    const second = await importHistoryCsv({ csv: mixed, mapping: CANONICAL }, trigger);
    expect(second).toMatchObject({ totalRows: 2, imported: 1, skippedDuplicates: 1 });
    expect(await chatRows("tg:chat:5")).toHaveLength(3);
  });

  it("imports a foreign CSV through an operator column mapping", async () => {
    const csv =
      "Conversation,MsgId,Who,Text,When,Author\n" +
      "tg:chat:777,10,human,imported question,1768392000,900\n" +
      "tg:chat:777,11,bot,imported answer,2026-07-14T10:00:10Z,\n";
    const result = await importHistoryCsv(
      {
        csv,
        mapping: {
          chat_ref: fromColumn("Conversation"),
          source_message_id: fromColumn("MsgId"),
          role: fromColumn("Who"),
          content: fromColumn("Text"),
          sent_at: fromColumn("When"),
          user_id: fromColumn("Author"),
        },
      },
      trigger,
    );
    expect(result).toMatchObject({ imported: 2, skippedDuplicates: 0, errors: [] });

    const restored = await chatRows("tg:chat:777");
    expect(
      restored
        .sort((a, b) => Number(b.sourceMessageId) - Number(a.sourceMessageId))
        .map((m) => ({ role: m.role, content: m.content, userId: m.userId })),
    ).toEqual([
      { role: "assistant", content: "imported answer", userId: null },
      { role: "user", content: "imported question", userId: "900" },
    ]);
  });

  it("imports the valid rows and reports the invalid ones per line", async () => {
    const csv =
      `${HISTORY_CSV_HEADERS.join(",")}\n` +
      `tg:chat:5,1,user,good,2026-07-14T10:00:00Z,100,,,\n` +
      `tg:chat:5,nope,user,bad id,2026-07-14T10:00:00Z,100,,,\n` +
      `tg:chat:5,3,alien,bad role,2026-07-14T10:00:00Z,100,,,\n`;
    const result = await importHistoryCsv({ csv, mapping: CANONICAL }, trigger);
    expect(result).toMatchObject({ totalRows: 3, imported: 1, skippedDuplicates: 0 });
    expect(result.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(await chatRows("tg:chat:5")).toHaveLength(1);
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
          source_message_id: fromColumn("mid"),
          content: fromColumn("body"),
          sent_at: fromColumn("when"),
          chat_ref: fromConstant("tg:chat:-1001234567890"),
          role: fromConstant("human"),
          user_id: fromConstant("900"),
        },
      },
      trigger,
    );
    expect(result).toMatchObject({ imported: 2, skippedDuplicates: 0, errors: [] });
    expect(result.chatRefs).toEqual(["tg:chat:-1001234567890"]);

    const restored = await chatRows("tg:chat:-1001234567890");
    expect(restored.map((m) => ({ role: m.role, userId: m.userId, content: m.content }))).toEqual([
      { role: "user", userId: "900", content: "first" },
      { role: "user", userId: "900", content: "second" },
    ]);
  });

  it("rejects an unusable fixed value, and a fixed message id, before writing anything", async () => {
    const csv = "mid,body,when\n1,first,2026-07-14T10:00:00Z\n";
    const base = {
      source_message_id: fromColumn("mid"),
      content: fromColumn("body"),
      sent_at: fromColumn("when"),
      chat_ref: fromConstant("tg:chat:5"),
      role: fromConstant("user"),
    };

    await expect(
      importHistoryCsv({ csv, mapping: { ...base, role: fromConstant("alien") } }, trigger),
    ).rejects.toThrow(/role must be user or assistant/);

    // The unique key can never be a fixed value — every row would collapse into one.
    await expect(
      importHistoryCsv(
        { csv, mapping: { ...base, source_message_id: fromConstant("7") } },
        trigger,
      ),
    ).rejects.toThrow(/must come from a column/);

    expect(await chatRows("tg:chat:5")).toHaveLength(0);
  });

  it("rejects a file with an unmapped required column, an empty file, and an all-invalid file", async () => {
    const csv = `${HISTORY_CSV_HEADERS.join(",")}\ntg:chat:5,1,user,x,2026-07-14T10:00:00Z,,,,\n`;
    await expect(
      importHistoryCsv({ csv, mapping: { chat_ref: fromColumn("chat_ref") } }, trigger),
    ).rejects.toThrow(/Unmapped required column/);

    await expect(
      importHistoryCsv({ csv: HISTORY_CSV_HEADERS.join(","), mapping: CANONICAL }, trigger),
    ).rejects.toThrow(/no data rows/);

    const allBad = `${HISTORY_CSV_HEADERS.join(",")}\ntg:chat:5,x,user,bad,not-a-date,,,,\n`;
    await expect(importHistoryCsv({ csv: allBad, mapping: CANONICAL }, trigger)).rejects.toThrow(
      /No valid rows/,
    );

    expect(await chatRows("tg:chat:5")).toHaveLength(0);
  });

  it("traces the import under the history feature, with the mapping and outcome", async () => {
    const csv = `${HISTORY_CSV_HEADERS.join(",")}\ntg:chat:5,1,user,traced,2026-07-14T10:00:00Z,100,,,\n`;
    await importHistoryCsv({ csv, mapping: CANONICAL }, trigger);

    const { traces } = await listTraces({ feature: "history" });
    expect(traces[0]).toMatchObject({ feature: "history", action: "import", status: "success" });
    expect(traces[0].outputSummary).toContain("imported 1");
  });

  it("records a failed import as a failed trace", async () => {
    await expect(importHistoryCsv({ csv: "a,b\n1,2\n", mapping: {} }, trigger)).rejects.toThrow();
    const { traces } = await listTraces({ feature: "history" });
    expect(traces[0]).toMatchObject({ action: "import", status: "error" });
  });
});
