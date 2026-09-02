import { z } from "zod";

import { MAX_CONTENT_CHARS, MAX_CSV_CHARS, HISTORY_CSV_FIELDS, type ColumnMapping, type ColumnSource } from "../csv";
import type { ChatMessageRecord, ChatSummary } from "./repository";

/**
 * Validation schemas and client-facing types for the history mirror. The
 * mirror itself is written by the ingest (every transport's events land in
 * the conversation store); what is validated here is the operator's own
 * input — the CSV transfer.
 */

/**
 * Upper bound on a single stored message. Defined in the client-safe `../csv`
 * module so the import preview enforces the same cap in the browser, and
 * re-exported here as the mirror's own constant.
 */
export { MAX_CONTENT_CHARS };

/** Where one field's value comes from: a column of the file, or a fixed value. */
const columnSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), header: z.string().min(1) }),
  z.object({ kind: z.literal("constant"), value: z.string().max(MAX_CONTENT_CHARS) }),
]);

/**
 * A CSV import request: the raw file text plus the operator's column mapping.
 * The server re-parses the text with the same pure module the mapping preview
 * used — the client's parse is never trusted.
 */
export const importHistorySchema = z.object({
  csv: z.string().min(1).max(MAX_CSV_CHARS),
  mapping: z.object(
    Object.fromEntries(
      HISTORY_CSV_FIELDS.map((field) => [field.key, columnSourceSchema.nullish()]),
    ) as Record<string, z.ZodType<ColumnSource | null | undefined>>,
  ),
  /** Delimiter override; sniffed from the header when omitted. */
  delimiter: z.string().length(1).optional(),
});
export type ImportHistoryInput = z.infer<typeof importHistorySchema> & { mapping: ColumnMapping };

/** Which chat (scoped ref) to export, or every chat when omitted. */
export const exportHistoryQuerySchema = z.object({
  chatRef: z.string().min(1).optional(),
});
export type ExportHistoryQuery = z.infer<typeof exportHistoryQuerySchema>;

/** Client-facing shapes (already free of secrets). */
export type ChatMessageView = ChatMessageRecord;
export type ChatSummaryView = ChatSummary;

/**
 * A stored message plus the id of the trace that handled its turn, so the
 * dashboard can link a message straight to its `/debug/[id]` trace. For a user
 * message that is the trace of the reply it triggered; for an assistant reply it
 * is the same trace (resolved via the message it replied to). Null when no trace
 * exists (e.g. an un-addressed message that was never handled).
 */
export interface ChatMessageWithTrace extends ChatMessageRecord {
  traceId: string | null;
  /**
   * Rendered media annotation for this message (` [photo: <description>]` /
   * ` [photo]`), so a media message reads as text instead of blank content.
   * Null when the message carries no media.
   */
  mediaSuffix?: string | null;
}
