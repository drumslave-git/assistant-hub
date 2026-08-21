import { describe, expect, it } from "vitest";

import {
  detectDelimiter,
  fromColumn,
  fromConstant,
  guessMapping,
  HISTORY_CSV_HEADERS,
  mapCsvRows,
  missingRequiredFields,
  parseCsv,
  rowsToCsv,
  toCsv,
  type ColumnMapping,
} from "./csv";

/** The canonical mapping an export round-trips with. */
const IDENTITY_MAPPING: ColumnMapping = guessMapping(HISTORY_CSV_HEADERS);

/** Shorthand for a mapping of field key → column header. */
function columns(pairs: Record<string, string>): ColumnMapping {
  return Object.fromEntries(
    Object.entries(pairs).map(([key, header]) => [key, fromColumn(header)]),
  ) as ColumnMapping;
}

describe("parseCsv", () => {
  it("parses quoted fields, escaped quotes, embedded newlines and CRLF", () => {
    const table = parseCsv('a,b\r\n1,"he said ""hi"""\r\n2,"line one\nline two"\r\n');
    expect(table.headers).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["1", 'he said "hi"'],
      ["2", "line one\nline two"],
    ]);
  });

  it("strips a BOM and drops blank lines", () => {
    const table = parseCsv("﻿a,b\n1,2\n\n3,4\n");
    expect(table.headers).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("detects a semicolon delimiter (Excel's European dialect)", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    const table = parseCsv("a;b\n1;2");
    expect(table.delimiter).toBe(";");
    expect(table.rows).toEqual([["1", "2"]]);
  });

  it("round-trips through toCsv", () => {
    const headers = ["a", "b"];
    const rows = [['say "hi"', "x,y"], ["multi\nline", " padded "]];
    const table = parseCsv(toCsv(headers, rows));
    expect(table.headers).toEqual(headers);
    expect(table.rows).toEqual(rows);
  });
});

describe("guessMapping", () => {
  it("auto-maps the canonical export header", () => {
    expect(guessMapping(HISTORY_CSV_HEADERS)).toEqual(IDENTITY_MAPPING);
  });

  it("maps loosely-named foreign headers via aliases", () => {
    const mapping = guessMapping(["Chat ID", "MessageId", "From", "Text", "Date"]);
    expect(mapping).toEqual(
      columns({
        chat_id: "Chat ID",
        telegram_message_id: "MessageId",
        role: "From",
        content: "Text",
        sent_at: "Date",
      }),
    );
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it("maps the foreign header shape seen live (Conversation/MsgId/Who/Text/When)", () => {
    const mapping = guessMapping([
      "Conversation",
      "MsgId",
      "Who",
      "Text",
      "When",
      "Author",
      "ReplyTo",
    ]);
    expect(missingRequiredFields(mapping)).toEqual([]);
    expect(mapping).toMatchObject(
      columns({
        chat_id: "Conversation",
        telegram_message_id: "MsgId",
        role: "Who",
        content: "Text",
        sent_at: "When",
        // "Author" is the sender id, not the role — the role alias set excludes it.
        user_id: "Author",
        reply_to_message_id: "ReplyTo",
      }),
    );
  });

  it("leaves unrecognized headers unmapped and reports the missing required ones", () => {
    const mapping = guessMapping(["foo", "bar"]);
    expect(mapping).toEqual({});
    expect(missingRequiredFields(mapping)).toEqual([
      "chat_id",
      "telegram_message_id",
      "role",
      "content",
      "sent_at",
    ]);
  });
});

describe("mapCsvRows", () => {
  it("coerces a mapped row into a persistable record", () => {
    const table = parseCsv(
      "chat,mid,who,body,when,uid,replyto\n" +
        "-100,7,human,hello,2026-07-14T10:00:00.000Z,42,3\n",
    );
    const { rows, errors } = mapCsvRows(
      table,
      columns({
        chat_id: "chat",
        telegram_message_id: "mid",
        role: "who",
        content: "body",
        sent_at: "when",
        user_id: "uid",
        reply_to_message_id: "replyto",
      }),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        chatId: "-100",
        telegramMessageId: 7,
        role: "user",
        userId: "42",
        content: "hello",
        replyToMessageId: 3,
        sentAt: new Date("2026-07-14T10:00:00.000Z"),
        editedAt: null,
        deletedAt: null,
      },
    ]);
  });

  it("accepts Unix timestamps (seconds and milliseconds)", () => {
    const table = parseCsv(
      "chat_id,telegram_message_id,role,content,sent_at\n" +
        "5,1,user,a,1768392000\n" +
        "5,2,user,b,1768392000000\n",
    );
    const { rows, errors } = mapCsvRows(table, IDENTITY_MAPPING);
    expect(errors).toEqual([]);
    expect(rows[0].sentAt.toISOString()).toBe(rows[1].sentAt.toISOString());
  });

  it("nulls the sender on assistant rows", () => {
    const table = parseCsv(
      "chat_id,telegram_message_id,role,content,sent_at,user_id\n" +
        "5,1,bot,hi,2026-07-14T10:00:00Z,99\n",
    );
    const { rows } = mapCsvRows(table, IDENTITY_MAPPING);
    expect(rows[0]).toMatchObject({ role: "assistant", userId: null });
  });

  it("reports bad rows per line without dropping the good ones", () => {
    const table = parseCsv(
      "chat_id,telegram_message_id,role,content,sent_at\n" +
        "5,1,user,ok,2026-07-14T10:00:00Z\n" +
        ",2,user,no chat,2026-07-14T10:00:00Z\n" +
        "5,abc,user,bad id,2026-07-14T10:00:00Z\n" +
        "5,4,ghost,bad role,2026-07-14T10:00:00Z\n" +
        "5,5,user,bad date,not-a-date\n",
    );
    const { rows, errors } = mapCsvRows(table, IDENTITY_MAPPING);
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(errors[0].message).toContain("chat_id");
    expect(errors[1].message).toContain("telegram_message_id");
    expect(errors[2].message).toContain("role");
    expect(errors[3].message).toContain("sent_at");
  });

  it("allows empty content (a media message with no caption)", () => {
    const table = parseCsv("chat_id,telegram_message_id,role,content,sent_at\n5,1,user,,2026-07-14T10:00:00Z\n");
    const { rows, errors } = mapCsvRows(table, IDENTITY_MAPPING);
    expect(errors).toEqual([]);
    expect(rows[0].content).toBe("");
  });

  it("reports an unmapped required column as a mapping problem, not a row error", () => {
    const table = parseCsv("a,b\n1,2\n");
    const { rows, errors, missing } = mapCsvRows(table, columns({ chat_id: "a" }));
    expect(rows).toEqual([]);
    // Not a row that failed validation — the file was never evaluated.
    expect(errors).toEqual([]);
    expect(missing).toEqual(["telegram_message_id", "role", "content", "sent_at"]);
  });
});

describe("mapCsvRows with fixed values", () => {
  /** A per-chat export: no chat column, no sender column, all human messages. */
  const table = parseCsv("mid,body,when\n1,first,2026-07-14T10:00:00Z\n2,second,2026-07-14T10:01:00Z\n");
  const mapping: ColumnMapping = {
    ...columns({ telegram_message_id: "mid", content: "body", sent_at: "when" }),
    chat_id: fromConstant("-1001234567890"),
    role: fromConstant("human"),
    user_id: fromConstant("900"),
  };

  it("applies a fixed value to every row, coerced like a column would be", () => {
    const { rows, errors, missing, invalidConstants } = mapCsvRows(table, mapping);
    expect({ errors, missing, invalidConstants }).toEqual({
      errors: [],
      missing: [],
      invalidConstants: [],
    });
    expect(rows).toEqual([
      {
        chatId: "-1001234567890",
        telegramMessageId: 1,
        role: "user",
        userId: "900",
        content: "first",
        replyToMessageId: null,
        sentAt: new Date("2026-07-14T10:00:00Z"),
        editedAt: null,
        deletedAt: null,
      },
      {
        chatId: "-1001234567890",
        telegramMessageId: 2,
        role: "user",
        userId: "900",
        content: "second",
        replyToMessageId: null,
        sentAt: new Date("2026-07-14T10:01:00Z"),
        editedAt: null,
        deletedAt: null,
      },
    ]);
  });

  it("satisfies a required column, so nothing is reported missing", () => {
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it("rejects a fixed value the field itself would reject — as a mapping problem, not N row errors", () => {
    const { rows, errors, invalidConstants } = mapCsvRows(table, {
      ...mapping,
      sent_at: fromConstant("not-a-date"),
      role: fromConstant("alien"),
    });
    expect(rows).toEqual([]);
    // Two bad rows would otherwise be reported twice each — once per data row.
    expect(errors).toEqual([]);
    expect(invalidConstants).toEqual([
      { field: "role", message: 'role must be user or assistant, got "alien"' },
      { field: "sent_at", message: 'sent_at is not a valid date: "not-a-date"' },
    ]);
  });

  it("refuses a fixed message id — it is the per-chat unique key", () => {
    const { rows, invalidConstants } = mapCsvRows(table, {
      ...mapping,
      telegram_message_id: fromConstant("7"),
    });
    expect(rows).toEqual([]);
    expect(invalidConstants).toHaveLength(1);
    expect(invalidConstants[0]).toMatchObject({ field: "telegram_message_id" });
    expect(invalidConstants[0].message).toContain("must come from a column");
  });

  it("still nulls the sender on assistant rows, even from a fixed value", () => {
    const { rows } = mapCsvRows(table, { ...mapping, role: fromConstant("bot") });
    expect(rows.map((r) => ({ role: r.role, userId: r.userId }))).toEqual([
      { role: "assistant", userId: null },
      { role: "assistant", userId: null },
    ]);
  });
});

describe("rowsToCsv", () => {
  it("emits the canonical header and round-trips back through mapCsvRows", () => {
    const csv = rowsToCsv([
      {
        chatId: "-1001",
        telegramMessageId: 12,
        role: "assistant",
        userId: null,
        content: 'reply, with "quotes"\nand a newline',
        replyToMessageId: 11,
        sentAt: "2026-07-14T10:00:00.000Z",
        editedAt: "2026-07-14T10:05:00.000Z",
        deletedAt: null,
      },
    ]);
    expect(csv.split("\n")[0]).toBe(HISTORY_CSV_HEADERS.join(","));

    const table = parseCsv(csv);
    const { rows, errors } = mapCsvRows(table, guessMapping(table.headers));
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({
      chatId: "-1001",
      telegramMessageId: 12,
      role: "assistant",
      userId: null,
      content: 'reply, with "quotes"\nand a newline',
      replyToMessageId: 11,
      sentAt: new Date("2026-07-14T10:00:00.000Z"),
      editedAt: new Date("2026-07-14T10:05:00.000Z"),
      deletedAt: null,
    });
  });
});
