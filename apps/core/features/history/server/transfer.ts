import "server-only";

import { resetInsightScanFloor } from "@/features/analytics/server/watermark";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import {
  invalidConstants,
  mapCsvRows,
  missingRequiredFields,
  parseCsv,
  rowsToCsv,
  MAX_IMPORT_ROWS,
  type RowError,
} from "../csv";
import { requireSourceContent } from "@/server/source/content";
import { getHistoryOverview } from "./service";
import type { ImportHistoryInput } from "./schema";

/**
 * CSV transfer for the history mirror — the operator's bulk in/out path.
 *
 * Export serializes the stored mirror (deleted rows included, flagged) with the
 * canonical header, so it round-trips straight back through import. Import is a
 * mutation and therefore traced end to end: the raw text is re-parsed here with
 * the same pure module the browser previewed with, every row is validated, and
 * writes skip rows that already exist — the mirror's `(chat_id,
 * telegram_message_id)` unique key makes a re-import idempotent rather than
 * destructive, so an operator can safely re-run a partially-applied file.
 */

const FEATURE = FEATURES["history"];

/** Rows are written in chunks so one statement never carries the whole file. */
const IMPORT_CHUNK_SIZE = 500;

/** The mirror as CSV — one chat, or every chat of every transport when `chatRef` is omitted. */
export async function exportHistoryCsv(chatRef?: string): Promise<string> {
  const content = requireSourceContent();
  if (chatRef) return rowsToCsv(await content.allMessages(chatRef));
  const chats = await getHistoryOverview();
  const records = [];
  // Ordered by chat then insertion, like the v1 export.
  for (const chat of [...chats].sort((a, b) => a.chatRef.localeCompare(b.chatRef))) {
    records.push(...(await content.allMessages(chat.chatRef)));
  }
  return rowsToCsv(records);
}

/** What an import actually did — reported back to the operator verbatim. */
export interface ImportResult {
  /** Data rows found in the file (the header is not counted). */
  totalRows: number;
  /** Rows written. */
  imported: number;
  /** Rows whose `(chatRef, sourceMessageId)` was already in the mirror. */
  skippedDuplicates: number;
  /** Rows that failed validation, with the reason, per line. */
  errors: RowError[];
  /** The chats (scoped refs) the imported rows landed in. */
  chatRefs: string[];
}

/**
 * Import a CSV into the mirror under the operator's column mapping. Valid rows
 * are written and duplicates skipped; invalid rows are reported per line rather
 * than failing the file. Traced (a mutation) with the full mapping and outcome.
 */
export async function importHistoryCsv(
  input: ImportHistoryInput,
  trigger: TraceTrigger,
): Promise<ImportResult> {
  const trace = await startTrace(
    { feature: FEATURE.id, action: "import", trigger, inputSummary: "CSV import" }
  );
  try {
    const table = parseCsv(input.csv, input.delimiter);
    await trace.event({
      type: "input",
      message: "CSV parsed",
      data: {
        headers: table.headers,
        delimiter: table.delimiter,
        rowCount: table.rows.length,
        mapping: input.mapping,
      },
    });

    const missing = missingRequiredFields(input.mapping);
    if (missing.length > 0) {
      throw ApiError.badRequest(`Unmapped required column(s): ${missing.join(", ")}`);
    }
    // A fixed value stands in for every row, so an unusable one is a mapping
    // error, not 5000 identical row errors.
    const badConstants = invalidConstants(input.mapping);
    if (badConstants.length > 0) {
      throw ApiError.badRequest(badConstants.map((error) => error.message).join("; "));
    }
    if (table.rows.length === 0) throw ApiError.badRequest("The file has no data rows");
    if (table.rows.length > MAX_IMPORT_ROWS) {
      throw ApiError.badRequest(
        `At most ${MAX_IMPORT_ROWS} rows can be imported at once (the file has ${table.rows.length})`,
      );
    }

    const { rows, errors } = mapCsvRows(table, input.mapping);
    await trace.event({
      type: "input",
      message: "rows validated",
      level: errors.length > 0 ? "warn" : "info",
      data: { valid: rows.length, invalid: errors.length, errors },
    });

    // A file whose every row is bad is an operator mistake, not an empty import.
    if (rows.length === 0) {
      throw ApiError.badRequest(
        `No valid rows to import (${errors.length} row(s) failed validation)`,
      );
    }

    // Rows land in the owning source's store, grouped per chat (its write
    // path is chat-scoped), chunked so one request never carries the file.
    const content = requireSourceContent();
    const byChat = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byChat.get(row.chatRef);
      if (list) list.push(row);
      else byChat.set(row.chatRef, [row]);
    }
    let imported = 0;
    for (const [chatRef, chatRows] of byChat) {
      for (let i = 0; i < chatRows.length; i += IMPORT_CHUNK_SIZE) {
        imported += await content.importMessages(
          chatRef,
          chatRows.slice(i, i + IMPORT_CHUNK_SIZE).map((row) => ({
            sourceMessageId: row.sourceMessageId,
            role: row.role,
            userId: row.userId ?? null,
            content: row.content,
            replyToSourceMessageId: row.replyToSourceMessageId ?? null,
            sentAt: row.sentAt,
            editedAt: row.editedAt ?? null,
            deletedAt: row.deletedAt ?? null,
          })),
        );
      }
    }

    const result: ImportResult = {
      totalRows: table.rows.length,
      imported,
      skippedDuplicates: rows.length - imported,
      errors,
      chatRefs: [...byChat.keys()].sort(),
    };
    await trace.event({
      type: "db",
      message: "messages imported",
      data: {
        imported: result.imported,
        skippedDuplicates: result.skippedDuplicates,
        chatRefs: result.chatRefs,
      },
    });

    if (result.imported > 0) {
      publishEvent(FEATURE.realtimeTopic);
      // Imported rows can land in hours the analytics due-scan has already
      // proven scored — drop its floor so those hours become owed work again
      // (the same poke pattern as the bot manager arming the vision backfill).
      resetInsightScanFloor();
    }
    await trace.succeed({
      outputSummary: `imported ${result.imported}, skipped ${result.skippedDuplicates}, invalid ${errors.length}`,
      relatedIds: { [FEATURE.relatedIdsKey]: result.chatRefs },
    });
    return result;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
