import { describe, expect, it } from "vitest";

import type { Trace, TraceEvent } from "@/lib/trace";
import { ADDRESSING_CHECK_EVENT, readAddressingCheck } from "./addressing-trace";

/** A minimal trace carrying the given events, in order. */
function traceWith(events: Partial<TraceEvent>[]): Trace {
  return {
    id: "t1",
    feature: "bot-messaging",
    action: "reply",
    status: "success",
    trigger: { kind: "telegram" },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    events: events.map((event, seq) => ({
      id: `e${seq}`,
      traceId: "t1",
      seq,
      ts: new Date().toISOString(),
      type: "step",
      level: "info",
      message: "step",
      ...event,
    })) as TraceEvent[],
  };
}

describe("readAddressingCheck", () => {
  it("reads the decision the reply was made on", () => {
    const trace = traceWith([
      { message: "some other step", data: { matchedText: "nonsense" } },
      {
        message: ADDRESSING_CHECK_EVENT,
        data: {
          addressed: true,
          source: "analyzer",
          reason: 'display name appears as other_alphabet ("Георгій")',
          matchedText: "Георгій",
          botDisplayName: "Aria",
        },
      },
    ]);
    expect(readAddressingCheck(trace)).toEqual({
      addressed: true,
      source: "analyzer",
      reason: 'display name appears as other_alphabet ("Георгій")',
      matchedText: "Георгій",
      botDisplayName: "Aria",
    });
  });

  // A reply from before these fields were recorded must read as "nothing to
  // exclude", never as a decision with invented content.
  it("reports absent fields as null rather than guessing", () => {
    const trace = traceWith([
      { message: ADDRESSING_CHECK_EVENT, data: { addressed: true, source: "mention" } },
    ]);
    expect(readAddressingCheck(trace)).toEqual({
      addressed: true,
      source: "mention",
      reason: null,
      matchedText: null,
      botDisplayName: null,
    });
  });

  it("returns null when the trace holds no addressing decision", () => {
    expect(readAddressingCheck(traceWith([{ message: "request" }]))).toBeNull();
  });
});
