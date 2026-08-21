import { z } from "zod";

import {
  HISTORY_CSV_FIELDS,
  MAX_CONTENT_CHARS,
  MAX_CSV_CHARS,
  type ColumnMapping,
  type ColumnSource,
} from "../csv";
import type { ChatMessageRecord, ChatSummary } from "./repository";

/**
 * Validation schemas and client-facing types for the history mirror. Unlike most
 * features, history is driven by the Telegram runtime rather than a client form,
 * so these schemas validate the runtime's inputs before they reach persistence.
 */

/**
 * Upper bound on a single stored message (mirrors Telegram's own message cap).
 * Defined in the client-safe `../csv` module so the import preview enforces the
 * same cap in the browser, and re-exported here as the mirror's own constant.
 */
export { MAX_CONTENT_CHARS };

const chatId = z.string().min(1);
const telegramMessageId = z.number().int().positive();

/** A human/assistant message captured into the mirror. */
export const recordMessageSchema = z.object({
  chatId,
  telegramMessageId,
  role: z.enum(["user", "assistant"]),
  userId: z.string().min(1).nullable().optional(),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
  replyToMessageId: z.number().int().positive().nullable().optional(),
  sentAt: z.date(),
});
export type RecordMessageInput = z.infer<typeof recordMessageSchema>;

/**
 * A media-bearing message captured into the mirror. Same shape as
 * {@link recordMessageSchema} but content may be empty (a photo/sticker with no
 * caption still belongs in the transcript — its image is described separately and
 * rendered as a media suffix).
 */
export const recordMediaMessageSchema = recordMessageSchema.extend({
  content: z.string().trim().max(MAX_CONTENT_CHARS),
});
export type RecordMediaMessageInput = z.infer<typeof recordMediaMessageSchema>;

/** An `edited_message` update rewriting a previously stored row. */
export const applyEditSchema = z.object({
  chatId,
  telegramMessageId,
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
  editedAt: z.date(),
});
export type ApplyEditInput = z.infer<typeof applyEditSchema>;

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

/** Which chat to export, or every chat when omitted. */
export const exportHistoryQuerySchema = z.object({
  chatId: z.string().min(1).optional(),
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
