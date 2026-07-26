import type { Trace } from "@/lib/trace";

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
 * Read the addressing decision off a reply trace, or null when the trace holds
 * none (a reply from before this was recorded, or a purged trace). The *last*
 * such event wins: one trace records one decision, but reading the latest keeps
 * a re-decided turn honest.
 */
export function readAddressingCheck(trace: Trace): AddressingCheckRecord | null {
  for (let i = trace.events.length - 1; i >= 0; i -= 1) {
    const event = trace.events[i];
    if (event.message !== ADDRESSING_CHECK_EVENT) continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    return {
      addressed: data.addressed === true,
      source: str(data.source),
      reason: str(data.reason),
      matchedText: str(data.matchedText),
      botDisplayName: str(data.botDisplayName),
    };
  }
  return null;
}
