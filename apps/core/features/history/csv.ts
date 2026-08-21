/**
 * CSV transfer for the history mirror — pure, client-safe, dependency-free.
 *
 * Shared by both ends of the transfer so there is exactly one CSV dialect in the
 * product: the import page parses the operator's file in the browser to render
 * the column-mapping preview, and the server re-parses the same text with the
 * same code before writing (the client's parse is never trusted). The export
 * writes the canonical header, so an export round-trips back through the import
 * with the auto-detected mapping.
 */

/** A parsed CSV table: the header row plus the data rows. */
export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

/** Upper bound on a single import (rows and raw bytes), so a paste cannot OOM. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_CSV_CHARS = 5_000_000;

const DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Sniff the delimiter from the header line — Excel in a European locale writes
 * `;`-separated files, and Telegram-adjacent tools sometimes emit TSV.
 */
export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse RFC 4180-style CSV: quoted fields, `""` escapes, embedded newlines, CRLF
 * or LF line endings, optional BOM. The first non-empty row is the header.
 */
export function parseCsv(input: string, delimiter?: string): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;

  const endField = () => {
    record.push(field);
    field = "";
    quoted = false;
  };
  const endRecord = () => {
    endField();
    // Drop blank lines (a trailing newline, or a spacer row).
    if (record.some((cell) => cell !== "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRecord();
      continue;
    }
    field += ch;
  }
  if (field !== "" || quoted || record.length > 0) endRecord();

  const [headers = [], ...rows] = records;
  return { headers, rows, delimiter: sep };
}

/** Quote a cell only when it would otherwise change meaning. */
function encodeCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value !== value.trim();
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialize a header + rows to CSV text (LF line endings, no trailing newline). */
export function toCsv(headers: string[], rows: readonly (readonly string[])[], delimiter = ","): string {
  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => encodeCell(cell, delimiter)).join(delimiter),
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Column model                                                               */
/* -------------------------------------------------------------------------- */

/** The mirror's importable columns. Keys double as the canonical CSV headers. */
export const HISTORY_CSV_FIELDS = [
  {
    key: "chat_id",
    label: "Chat ID",
    required: true,
    constant: true,
    hint: "Telegram chat/group id the message belongs to.",
    constantHint: "e.g. a per-chat export with no chat column — apply one chat id to every row.",
    aliases: ["chat", "chatid", "conversation", "conversationid", "peerid", "dialogid"],
  },
  {
    key: "telegram_message_id",
    label: "Message ID",
    required: true,
    // The only field that cannot take a fixed value: it is the per-chat unique
    // key, so one value for every row would collapse the whole file into a
    // single message.
    constant: false,
    hint: "Telegram message id — unique within the chat, and the key duplicates are detected on.",
    aliases: ["messageid", "msgid", "id", "telegramid"],
  },
  {
    key: "role",
    label: "Role",
    required: true,
    constant: true,
    hint: "Who sent it: user (a human) or assistant (the bot). human and bot are accepted too.",
    constantHint: "e.g. a file that is all human messages — apply one role to every row.",
    // Deliberately excludes "author": in most exports that column carries the
    // sender's id, not the role — it belongs to `user_id`.
    aliases: ["who", "sender", "from", "speaker", "direction", "type"],
  },
  {
    key: "content",
    label: "Content",
    required: true,
    constant: true,
    hint: "The message text. May be empty (a media message with no caption).",
    aliases: ["text", "message", "body", "msg"],
  },
  {
    key: "sent_at",
    label: "Sent at",
    required: true,
    constant: true,
    hint: "When the message existed in Telegram. ISO 8601, or a Unix timestamp.",
    constantHint: "e.g. a file with no timestamps — stamp every row with one instant.",
    aliases: ["sent", "date", "timestamp", "time", "when", "createdat"],
  },
  {
    key: "user_id",
    label: "Sender user ID",
    required: false,
    constant: true,
    hint: "Numeric Telegram user id of the sender. Ignored for assistant rows.",
    constantHint: "e.g. a one-person chat log — apply that sender's id to every human row.",
    aliases: ["userid", "fromid", "senderid", "authorid", "author"],
  },
  {
    key: "reply_to_message_id",
    label: "Reply to message ID",
    required: false,
    constant: true,
    hint: "The Telegram message id this one replied to.",
    aliases: ["replyto", "replytomessageid", "replytoid", "inreplyto"],
  },
  {
    key: "edited_at",
    label: "Edited at",
    required: false,
    constant: true,
    hint: "When the message was last edited, if ever.",
    aliases: ["edited", "editdate", "editedat"],
  },
  {
    key: "deleted_at",
    label: "Deleted at",
    required: false,
    constant: true,
    hint: "When the message is known to have been deleted, if ever.",
    aliases: ["deleted", "deletedat"],
  },
] as const satisfies readonly HistoryCsvField[];

export interface HistoryCsvField {
  key: string;
  label: string;
  required: boolean;
  /** Whether a fixed value may stand in for a column the file does not have. */
  constant: boolean;
  hint: string;
  /** Why a fixed value is useful here, shown when the operator picks one. */
  constantHint?: string;
  aliases: readonly string[];
}

/** A canonical column key (`chat_id`, `role`, …). */
export type HistoryCsvFieldKey = (typeof HISTORY_CSV_FIELDS)[number]["key"];

/**
 * The hint to show for a field, given how it is sourced. `HISTORY_CSV_FIELDS` is
 * `as const`, so only some members carry `constantHint` — this reads it through
 * the widened field type instead of making every caller narrow the union.
 */
export function fieldHint(field: HistoryCsvField, isConstant: boolean): string {
  return (isConstant ? field.constantHint : undefined) ?? field.hint;
}

/** The canonical export header, in column order. */
export const HISTORY_CSV_HEADERS: string[] = HISTORY_CSV_FIELDS.map((f) => f.key);

/**
 * Where one field's value comes from: a column of the file, or a fixed value the
 * operator supplies for every row (for a field the file simply does not carry).
 */
export type ColumnSource =
  | { kind: "column"; header: string }
  | { kind: "constant"; value: string };

/**
 * Operator's mapping: field key → its source. An unmapped optional field is
 * absent (or null).
 */
export type ColumnMapping = Partial<Record<HistoryCsvFieldKey, ColumnSource | null>>;

/** A field read from a column of the file. */
export function fromColumn(header: string): ColumnSource {
  return { kind: "column", header };
}

/** A field given one fixed value, used for every row. */
export function fromConstant(value: string): ColumnSource {
  return { kind: "constant", value };
}

/** Loose header comparison — case/space/underscore/dash-insensitive. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Best-effort auto-mapping of a file's headers onto the mirror's columns: an
 * exact (normalized) key match first, then the per-field aliases. Anything the
 * heuristic cannot place is left unmapped for the operator to pick.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  for (const field of HISTORY_CSV_FIELDS) {
    const candidates = [normalizeHeader(field.key), ...field.aliases.map(normalizeHeader)];
    for (const candidate of candidates) {
      const match = headers.find(
        (header) => !taken.has(header) && normalizeHeader(header) === candidate,
      );
      if (match) {
        mapping[field.key] = fromColumn(match);
        taken.add(match);
        break;
      }
    }
  }
  return mapping;
}

/* -------------------------------------------------------------------------- */
/* Row coercion                                                               */
/* -------------------------------------------------------------------------- */

/** Upper bound on a single stored message (kept in step with the mirror's cap). */
export const MAX_CONTENT_CHARS = 8192;

/** One import row, coerced and ready for persistence. */
export interface ImportRow {
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToMessageId: number | null;
  sentAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/** A row the operator must fix — reported per line, never silently dropped. */
export interface RowError {
  /** 1-based data-row number (the header is not counted). */
  line: number;
  message: string;
}

/** A fixed value that is not acceptable for the field it was given to. */
export interface ConstantError {
  field: HistoryCsvFieldKey;
  message: string;
}

/** The outcome of applying a mapping to a parsed file. */
export interface MappedRows {
  rows: ImportRow[];
  errors: RowError[];
  /**
   * Required columns the mapping does not cover. Non-empty means nothing could
   * be mapped at all — a mapping problem, not a row problem, so `rows` and
   * `errors` are both empty and the caller must resolve this first.
   */
  missing: HistoryCsvFieldKey[];
  /**
   * Fixed values that fail their field's own validation (a bad date, an unknown
   * role, …). Like {@link MappedRows.missing} this is a mapping problem — it
   * would otherwise fail every single row identically — so nothing is coerced
   * until the operator fixes it.
   */
  invalidConstants: ConstantError[];
}

const ROLE_ALIASES: Record<string, "user" | "assistant"> = {
  user: "user",
  human: "user",
  person: "user",
  assistant: "assistant",
  bot: "assistant",
  ai: "assistant",
};

/** Parse an id-like cell: a positive integer, or null when empty. */
function parseId(value: string): number | null | undefined {
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse a timestamp cell: ISO 8601, or a Unix timestamp in seconds (Telegram's
 * own `message.date`) or milliseconds. Empty → null.
 */
function parseDate(value: string): Date | null | undefined {
  if (value === "") return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // Seconds vs milliseconds: anything below ~year 5138 in ms is a seconds value.
    const date = new Date(n < 100_000_000_000 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The field keys that must be mapped before an import can run. */
export function missingRequiredFields(mapping: ColumnMapping): HistoryCsvFieldKey[] {
  return HISTORY_CSV_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
}

/**
 * Validate one raw value for one field — the single definition of what each
 * column accepts. Used for both a cell read from the file and a fixed value the
 * operator supplied, so a constant is held to exactly the same standard as a
 * column (and reports the same message). Returns null when acceptable.
 */
export function validateFieldValue(key: HistoryCsvFieldKey, raw: string): string | null {
  switch (key) {
    case "chat_id":
      return raw === "" ? "chat_id is empty" : null;
    case "telegram_message_id":
      return parseId(raw) == null
        ? `telegram_message_id is not a positive integer: "${raw}"`
        : null;
    case "role":
      return ROLE_ALIASES[raw.toLowerCase()]
        ? null
        : `role must be user or assistant, got "${raw}"`;
    case "content":
      return raw.length > MAX_CONTENT_CHARS
        ? `content exceeds ${MAX_CONTENT_CHARS} characters`
        : null;
    case "sent_at":
      return parseDate(raw) == null ? `sent_at is not a valid date: "${raw}"` : null;
    case "reply_to_message_id":
      return parseId(raw) === undefined
        ? `reply_to_message_id is not a positive integer: "${raw}"`
        : null;
    case "edited_at":
      return parseDate(raw) === undefined ? `edited_at is not a valid date: "${raw}"` : null;
    case "deleted_at":
      return parseDate(raw) === undefined ? `deleted_at is not a valid date: "${raw}"` : null;
    case "user_id":
      return null;
  }
}

/**
 * Fixed values that their field would reject. Checked before any row is coerced:
 * a bad constant fails every row identically, which is a mapping problem, not a
 * data problem.
 */
export function invalidConstants(mapping: ColumnMapping): ConstantError[] {
  const errors: ConstantError[] = [];
  for (const field of HISTORY_CSV_FIELDS) {
    const source = mapping[field.key];
    if (source?.kind !== "constant") continue;
    if (!field.constant) {
      errors.push({
        field: field.key,
        message: `${field.label} must come from a column — it is unique per message, so one fixed value cannot stand for every row`,
      });
      continue;
    }
    const message = validateFieldValue(field.key, source.value.trim());
    if (message) errors.push({ field: field.key, message });
  }
  return errors;
}

/**
 * Coerce every data row of a parsed file through the operator's mapping. Valid
 * rows come back ready to persist; invalid ones come back as per-line errors, so
 * a single bad row never fails the whole import (nor is it silently skipped).
 * Fields mapped to a fixed value take that value on every row.
 */
export function mapCsvRows(table: CsvTable, mapping: ColumnMapping): MappedRows {
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];

  // Neither an unmapped required column nor an unusable fixed value is a row
  // problem — nothing can be coerced until the operator fixes the mapping.
  const missing = missingRequiredFields(mapping);
  const badConstants = invalidConstants(mapping);
  if (missing.length > 0 || badConstants.length > 0) {
    return { rows, errors, missing, invalidConstants: badConstants };
  }

  const columnIndexes = Object.fromEntries(
    HISTORY_CSV_FIELDS.map((field) => {
      const source = mapping[field.key];
      return [
        field.key,
        source?.kind === "column" ? table.headers.indexOf(source.header) : -1,
      ];
    }),
  ) as Record<HistoryCsvFieldKey, number>;

  /** This field's value for this row: the mapped cell, or the fixed value. */
  const valueFor = (row: readonly string[], key: HistoryCsvFieldKey): string => {
    const source = mapping[key];
    if (source?.kind === "constant") return source.value.trim();
    const index = columnIndexes[key];
    return index === -1 ? "" : (row[index] ?? "").trim();
  };

  table.rows.forEach((row, i) => {
    const line = i + 1;
    const get = (key: HistoryCsvFieldKey) => valueFor(row, key);

    const invalid = HISTORY_CSV_FIELDS.map((field) =>
      validateFieldValue(field.key, get(field.key)),
    ).find((message): message is string => message != null);
    if (invalid) {
      errors.push({ line, message: invalid });
      return;
    }

    const role = ROLE_ALIASES[get("role").toLowerCase()];
    const userId = get("user_id");
    rows.push({
      chatId: get("chat_id"),
      telegramMessageId: parseId(get("telegram_message_id"))!,
      role,
      // The bot's own rows have no sender; a stray value there would be a lie.
      userId: role === "assistant" || userId === "" ? null : userId,
      content: get("content"),
      replyToMessageId: parseId(get("reply_to_message_id")) ?? null,
      sentAt: parseDate(get("sent_at"))!,
      editedAt: parseDate(get("edited_at")) ?? null,
      deletedAt: parseDate(get("deleted_at")) ?? null,
    });
  });

  return { rows, errors, missing, invalidConstants: badConstants };
}

/** Render mirror rows as canonical CSV (the export format, and import's input). */
export function rowsToCsv(
  records: readonly {
    chatId: string;
    telegramMessageId: number;
    role: string;
    userId: string | null;
    content: string;
    replyToMessageId: number | null;
    sentAt: string;
    editedAt: string | null;
    deletedAt: string | null;
  }[],
): string {
  const rows = records.map((r) => [
    r.chatId,
    String(r.telegramMessageId),
    r.role,
    r.content,
    r.sentAt,
    r.userId ?? "",
    r.replyToMessageId == null ? "" : String(r.replyToMessageId),
    r.editedAt ?? "",
    r.deletedAt ?? "",
  ]);
  return toCsv(HISTORY_CSV_HEADERS, rows);
}
