import type { Trace, TraceEvent } from "@/lib/trace";

/**
 * The addressing decision as it is written to, and read back from, a reply
 * trace. Two features meet on this event: bot-messaging writes it when it
 * decides to answer, and the feedback flow reads it back when someone reports
 * "wasn't talking to you" — it is how a complaint about a reply becomes the
 * specific word that caused it. Shared here so the writer and the reader cannot
 * drift on the event's name or payload.
 */

/** Trace event message carrying the addressing decision. */
export const ADDRESSING_CHECK_EVENT = "addressing check";

/** The decision as recorded on a trace. Fields are null when not recorded. */
export interface AddressingCheckRecord {
  addressed: boolean;
  source: string | null;
  reason: string | null;
  /** The word the analyzer took for the display name, when it cited one. */
  matchedText: string | null;
  /** The display name the decision was made against. */
  botDisplayName: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * What decided the turn, for each source that decides it WITHOUT asking the
 * model. Keyed by the `source` on the verdict; `analyzer` is deliberately
 * absent — that is the one source whose exchange is in the trace.
 */
const DECIDED_WITHOUT_ANALYZER: Record<string, string> = {
  private: "a direct chat decides itself — the analyzer is never asked in one",
  reply: "Telegram marked the message as a reply to this assistant",
  mention: "Telegram marked an @mention of this bot's username",
  command: "Telegram marked a /command addressed to this bot's username",
  name: "the assistant's name matched literally, which settles the turn on its own",
  task: "a standing task claimed the message",
};

/**
 * Why this trace holds no addressing request and response — or null when it
 * holds one (an `analyzer` verdict) and the reader should go look at it.
 *
 * The addressing decision has two halves that look identical in the timeline
 * and are not: the cheap checks decide most turns with no model call at all,
 * so their verdict IS the whole exchange. Without this line the absence of a
 * request/response reads as missing data rather than as "nothing was asked",
 * which is a question the debug page should answer rather than provoke.
 *
 * Derived from the verdict rather than recorded beside it, so traces written
 * before this existed explain themselves too.
 */
export function analyzerNote(record: AddressingCheckRecord): string | null {
  if (record.source === "analyzer") return null;
  const why = record.source ? DECIDED_WITHOUT_ANALYZER[record.source] : undefined;
  const because = why ?? record.reason ?? "the deterministic checks settled it";
  return `No analyzer was asked — ${because}. This verdict is the whole decision; there is no request or response to read.`;
}

/**
 * Read the addressing decision off a reply trace, or null when the trace holds
 * none (a reply from before this was recorded, or a purged trace). The *last*
 * such event wins: one trace records one decision, but reading the latest keeps
 * a re-decided turn honest.
 */
export function readAddressingCheck(trace: Trace): AddressingCheckRecord | null {
  for (let i = trace.events.length - 1; i >= 0; i -= 1) {
    const record = readAddressingCheckEvent(trace.events[i]);
    if (record) return record;
  }
  return null;
}

/** The decision carried by one event, or null when it is not the verdict. */
export function readAddressingCheckEvent(event: TraceEvent): AddressingCheckRecord | null {
  if (event.message !== ADDRESSING_CHECK_EVENT) return null;
  const data = (event.data ?? {}) as Record<string, unknown>;
  return {
    addressed: data.addressed === true,
    source: str(data.source),
    reason: str(data.reason),
    matchedText: str(data.matchedText),
    botDisplayName: str(data.botDisplayName),
  };
}
