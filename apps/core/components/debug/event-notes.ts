import type { TraceEvent } from "@/lib/trace";
import {
  analyzerNote,
  readAddressingCheckEvent,
} from "@/features/bot-messaging/addressing-trace";

/**
 * Explanatory notes the timeline renders under an event's title.
 *
 * A trace step sometimes needs a sentence the payload cannot carry: not what
 * the step recorded, but what the reader should conclude from what is NOT
 * there. The addressing verdict is the case that forced this — most turns are
 * decided by the cheap checks with no model call, so the timeline holds a
 * verdict and no request/response, and silence about that reads as missing
 * data rather than as "nothing was asked".
 *
 * One implementation for every feature: notes are derived from the event, so
 * traces recorded before a note existed explain themselves too, and no
 * feature grows its own debug view to say one sentence. Add a case here when
 * a step's absence of a payload is itself the thing worth stating.
 */
export function eventNote(event: TraceEvent): string | null {
  const addressing = readAddressingCheckEvent(event);
  if (addressing) return analyzerNote(addressing);
  return null;
}
