import type { ChatMessageRecord } from "./repository";

/**
 * Pure helpers for rendering stored history rows as a conversation transcript
 * and for the rolling recent-history window boundary. No DB or secrets, so they
 * are unit-testable in isolation.
 *
 * History is injected as ONE user message containing a transcript, where every
 * line is anchored by its Telegram message id: `[#<id>] <sender>: <text>`. A
 * reply is marked with `[reply to #<id>]` (when the target is stored and can be
 * dereferenced) or with the quoted text inline (when it is not). The anchors let
 * the model follow reply chains precisely — who answered whom about what — and
 * dereference off-window targets via the history MCP tools.
 *
 * Known limitation (out of scope for now): forum-topic threads
 * (`message_thread_id`) are not stored, so a forum supergroup's topics are
 * interleaved into a single transcript.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Rolling window size for the auto-injected recent history. */
export const HISTORY_WINDOW_MS = 24 * HOUR_MS;

/** Start of the rolling recent-history window: 24 hours before `now`. */
export function historyWindowStart(now: Date): Date {
  return new Date(now.getTime() - HISTORY_WINDOW_MS);
}

/** Fallback speaker label when a sender cannot be resolved to a known user. */
export function fallbackSpeakerLabel(userId: string | null): string {
  return userId ? `User ${userId}` : "User";
}

/**
 * How a message's reply target is referenced in a transcript line:
 * - `anchor` — the target is stored in history, referenced as `#<id>` (the model
 *   can read it in the transcript or fetch it by id with the history tools). An
 *   optional partial `quote` (Telegram's quote feature) narrows the reference.
 * - `inline` — the target is not stored, so its sender and full text (never
 *   trimmed) are inlined; `text` is null when the target had no textual content.
 */
export type ReplyRef =
  | { kind: "anchor"; telegramMessageId: number; quote?: string | null }
  | { kind: "inline"; label: string | null; text: string | null };

/** Render a reply reference as its `[reply to …]` marker. */
export function renderReplyRef(ref: ReplyRef): string {
  if (ref.kind === "anchor") {
    const quote = ref.quote?.trim() ? `, quoting: "${ref.quote}"` : "";
    return `[reply to #${ref.telegramMessageId}${quote}]`;
  }
  const who = ref.label ? ` ${ref.label}` : "";
  if (ref.text == null || ref.text === "") {
    return `[reply to${who} (content not available)]`;
  }
  return `[reply to${who}: "${ref.text}"]`;
}

/** Parts of one transcript line. */
export interface TranscriptLineParts {
  telegramMessageId: number;
  /** Speaker label — a known-user label, or the bot label for its own replies. */
  label: string;
  replyRef?: ReplyRef | null;
  content: string;
}

/** Render one transcript line: `[#<id>] <sender> [reply to …]: <text>`. */
export function renderTranscriptLine(parts: TranscriptLineParts): string {
  const reply = parts.replyRef ? ` ${renderReplyRef(parts.replyRef)}` : "";
  return `[#${parts.telegramMessageId}] ${parts.label}${reply}: ${parts.content}`;
}

export interface TranscriptOptions {
  /** Resolved labels for human senders, keyed by Telegram user id. */
  speakerLabels?: ReadonlyMap<string, string>;
  /** Label for the bot's own (assistant) rows, e.g. `You (@MyBot)`. */
  botLabel?: string;
  /**
   * Media suffixes keyed by Telegram message id — how a media message reads as
   * text (e.g. ` [photo: <description>]`). Appended to the line so a past image
   * turn carries its description. Built by the caller from vision annotations, so
   * this module stays free of vision imports.
   */
  mediaSuffixes?: ReadonlyMap<number, string>;
}

/** Render one stored row as a transcript line. */
export function toTranscriptLine(record: ChatMessageRecord, options: TranscriptOptions): string {
  const label =
    record.role === "assistant"
      ? (options.botLabel ?? "You")
      : ((record.userId ? options.speakerLabels?.get(record.userId) : undefined) ??
        fallbackSpeakerLabel(record.userId));
  const replyRef: ReplyRef | null =
    record.replyToMessageId != null
      ? { kind: "anchor", telegramMessageId: record.replyToMessageId }
      : null;
  const line = renderTranscriptLine({
    telegramMessageId: record.telegramMessageId,
    label,
    replyRef,
    content: record.content,
  });
  return line + (options.mediaSuffixes?.get(record.telegramMessageId) ?? "");
}

/**
 * Preamble explaining the transcript format to the model. Kept byte-stable so
 * the transcript message stays cache-friendly at its start.
 *
 * It also marks the bot's own lines as non-evidence, right where they are read.
 * The system prompt ranks sources in the abstract (see `BASE_SYSTEM_PROMPT`'s
 * Grounding block); this says it at the point of use, because the failure it
 * guards against is exactly a bot line being read as plain transcript and
 * treated as established fact (production, 2026-07-28).
 */
export const TRANSCRIPT_PREAMBLE =
  'Recent messages in this chat (last 24 hours), oldest first. Each line is "[#<message_id>] <sender>: <text>"; ' +
  '"[reply to #<id>]" marks a reply to an earlier message. Lines from "You" are your own earlier replies. ' +
  "What the other people wrote is what was said in this chat; your own lines are not evidence of anything " +
  "beyond having said it, and may be wrong or invented. " +
  "To read a message referenced by #<id> but not shown here, fetch it by id with the history tools.";

/**
 * Render a full recent-history transcript (preamble + one line per stored row).
 * Returns null when there are no rows, so the caller can skip the message.
 */
export function renderTranscript(
  records: readonly ChatMessageRecord[],
  options: TranscriptOptions,
): string | null {
  if (records.length === 0) return null;
  const lines = records.map((record) => toTranscriptLine(record, options));
  return `${TRANSCRIPT_PREAMBLE}\n\n${lines.join("\n")}`;
}

/**
 * Leading tokens a model copies from the transcript format into its own reply:
 * an `[#<id>]` anchor, a `[reply to …]` marker (any of {@link renderReplyRef}'s
 * three shapes), or the bot's own speaker label (`You` / `You (@bot)`) when it
 * sits directly before one of those or before the line's colon. Sender labels in
 * general are NOT matched — an arbitrary `<word>:` opening is legitimate reply
 * text ("Fun fact: …").
 */
const LEADING_TRANSCRIPT_TOKEN =
  /^(?:\[#\d+\]|\[reply to [^\]]*\]|You(?: \(@\w+\))?(?=\s*(?:\[reply to |\[#\d+\]|:)))\s*/;

/**
 * Strip the transcript line format out of a model reply that echoed it.
 *
 * The transcript is input-only syntax, but a model that reads a current turn
 * rendered as `[#563] Igor [reply to #560]: …` sometimes answers in kind —
 * delivered to Telegram, `[reply to #560]` is meaningless noise on top of the
 * real reply threading (observed live on vLLM/gemma4-12b, 2026-08-11). This is
 * a mechanical guard over the app's own known syntax: leading markers are
 * removed (with the colon that closes the prefix); anything past them — and any
 * marker-like text deeper in the reply — is left untouched. A reply that was
 * nothing but markers is returned as-is: delivering the echo beats delivering
 * an empty message.
 */
export function stripTranscriptEcho(reply: string): string {
  let out = reply.trimStart();
  let stripped = false;
  for (let m = LEADING_TRANSCRIPT_TOKEN.exec(out); m; m = LEADING_TRANSCRIPT_TOKEN.exec(out)) {
    out = out.slice(m[0].length);
    stripped = true;
  }
  if (!stripped) return reply;
  out = out.replace(/^:\s*/, "").trimStart();
  return out ? out : reply;
}

/** Distinct non-null sender ids across a set of rows (for batch label lookup). */
export function collectUserIds(records: readonly ChatMessageRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.userId) ids.add(record.userId);
  }
  return [...ids];
}
