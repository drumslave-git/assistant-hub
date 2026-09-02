import { addCalendarDays, zonedDate, zonedWallClockToUtc } from "@/features/tasks/schedule";
import { extractJsonObject } from "@/lib/json";

/**
 * Pure core of history summarization: the prompt, the parsing of what comes back,
 * the wall-clock day boundaries, and the batching of a day's transcript. No DB, no
 * LLM, no secrets — so every rule here is unit-testable in isolation, and the
 * server module is left holding only I/O.
 *
 * Why summaries exist: every reply already carries the last 24 hours verbatim.
 * Anything older is recalled by *searching* — and searching raw messages is poor
 * (chat is full of "ok", "lol", and pronouns with no referent). So each chat-day
 * is compressed into a handful of self-contained topics, each carrying the
 * Telegram message ids it came from: search finds the topic, the ids lead back to
 * the exact original messages.
 */

/**
 * One stored message with its speaker resolved — the unit both consumers of a
 * chat-day transcript read: summarization here, and passive memory extraction
 * (`features/memory/server/extract.ts`).
 */
export interface SummarizableMessage {
  sourceMessageId: string;
  role: "user" | "assistant";
  content: string;
  /** Resolved speaker label (known-user name, or the bot). */
  label: string;
  /**
   * Sender's known-user id, or null for the bot's own rows. Summarization ignores
   * it — it exists for extraction, which must attribute a `user`-scope fact to a
   * real id rather than to a display name the model read off a transcript line.
   */
  userId: string | null;
  sentAt: string;
}

/** One topic the model distilled from a day. */
export interface SummaryTopic {
  content: string;
  /** Source-local ids of the messages the topic distilled (as the transcript anchored them). */
  messageIds: string[];
}

/** A `YYYY-MM-DD` wall-clock day in the operator timezone. */
export type SummaryDate = string;

/**
 * Transcript characters one LLM pass may carry. A busy group day can hold
 * thousands of messages — feeding it all at once overruns the model (the MVP hit
 * repetition loops doing exactly that), so a day is summarized in batches and the
 * topics unioned. A code constant, like the other model-shaped limits.
 */
export const SUMMARY_BATCH_CHARS = 24_000;

/**
 * Smallest batch budget the context-overflow retry may shrink to. A char budget
 * cannot see tokenization (a Cyrillic-heavy day holds roughly twice the tokens
 * of an English one at the same length), so an oversized batch is re-batched at
 * half the budget until the model accepts it — but never below this floor:
 * a pass this small failing means the endpoint is misconfigured, not the batch
 * too big, and shrinking further would just spray tiny requests at it.
 */
export const MIN_SUMMARY_BATCH_CHARS = 1_500;

/** Per-line transcript overhead (id anchor, timestamp, label) when costing a batch. */
const LINE_OVERHEAD_CHARS = 48;

export const SUMMARY_SYSTEM = `You compress one day of chat history into a small set of topic summaries for long-term recall.

Rules:
- Group the day's messages into distinct topics/threads. A day may have one topic or several.
- For each topic write a self-contained summary: what was discussed, any decisions or facts, and who was involved (use the names shown).
- Each summary must stand alone. Someone reading it months later, with no other context, must understand it — so never write "he said" or "the link above"; name the person and the subject.
- Every line is labelled [#<id>]. List the ids belonging to each topic in message_ids, so the original messages can be read back.
- Do not invent anything. Summarize only what is present.
- If the day holds nothing substantive (greetings, noise, stickers), return an empty topics array.
- Write each summary in the dominant language of that conversation.

Respond with JSON only, in exactly this shape:
{"topics": [{"content": "<self-contained summary>", "message_ids": [<id>, ...]}]}`;

/** Render one stored message as an id-anchored transcript line for the summarizer. */
export function toSummaryLine(message: SummarizableMessage): string {
  return `[#${message.sourceMessageId}] [${message.sentAt}] ${message.label}: ${message.content}`;
}

/** The user half of the summary prompt: the day being summarized + its transcript. */
export function buildSummaryPrompt(date: SummaryDate, messages: readonly SummarizableMessage[]): string {
  const transcript = messages.map(toSummaryLine).join("\n");
  return `Summarize the topics discussed in this chat on ${date}.\n\nMessages:\n${transcript}`;
}

/**
 * Split a day's messages into batches that each fit {@link SUMMARY_BATCH_CHARS}.
 * A single message longer than the budget still gets its own batch rather than
 * being dropped — the model can truncate it; we will not silently lose it.
 */
export function batchMessages(
  messages: readonly SummarizableMessage[],
  budgetChars: number = SUMMARY_BATCH_CHARS,
): SummarizableMessage[][] {
  const batches: SummarizableMessage[][] = [];
  let current: SummarizableMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const cost = message.content.length + message.label.length + LINE_OVERHEAD_CHARS;
    if (current.length > 0 && currentChars + cost > budgetChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(message);
    currentChars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Parse the model's topics. Lenient by design (see {@link extractJsonObject}):
 * a day's summary is not worth failing over a code fence. A topic with no usable
 * `content` is dropped; ids that are not digit strings (a message id is one in
 * every transport the core has met) are filtered out rather than poisoning the
 * id array.
 */
export function parseSummaryTopics(raw: string): SummaryTopic[] {
  const parsed = extractJsonObject(raw);
  const topics = parsed?.topics;
  if (!Array.isArray(topics)) return [];

  const result: SummaryTopic[] = [];
  for (const entry of topics) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!content) continue;
    const ids = Array.isArray(obj.message_ids)
      ? obj.message_ids
          .map((id) => (typeof id === "number" || typeof id === "string" ? String(id).trim() : ""))
          .filter((id) => /^\d+$/.test(id))
      : [];
    result.push({ content, messageIds: [...new Set(ids)] });
  }
  return result;
}

/**
 * The UTC instants bounding a wall-clock day in `timeZone`: `[from, to)`. The
 * day is the operator's, not UTC's — "what did we talk about on the 14th" means
 * the 14th where the operator lives, and a UTC boundary would split an evening
 * conversation across two summaries.
 */
export function summaryDayBounds(
  date: SummaryDate,
  timeZone: string,
): { from: Date; to: Date } {
  const [year, month, day] = date.split("-").map(Number);
  const from = zonedWallClockToUtc(year, month, day, 0, 0, timeZone);
  const next = addCalendarDays(year, month, day, 1);
  const to = zonedWallClockToUtc(next.year, next.month, next.day, 0, 0, timeZone);
  return { from, to };
}

/** Format a Y-M-D triple as `YYYY-MM-DD`. */
function formatDate(parts: { year: number; month: number; day: number }): SummaryDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Today's wall-clock date in `timeZone` — the day still in progress. */
export function currentSummaryDate(now: Date, timeZone: string): SummaryDate {
  return formatDate(zonedDate(now, timeZone));
}

/**
 * Whether a day is finished and therefore summarizable. Today is deliberately
 * excluded: it is still being lived, it is already injected verbatim into every
 * reply as the 24-hour window, and summarizing it now would just have to be
 * redone tonight.
 */
export function isSummarizableDay(date: SummaryDate, now: Date, timeZone: string): boolean {
  return date < currentSummaryDate(now, timeZone);
}
