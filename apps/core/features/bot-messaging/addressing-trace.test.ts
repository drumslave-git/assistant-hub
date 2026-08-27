import { describe, expect, it } from "vitest";

import type { Trace, TraceEvent } from "@/lib/trace";
import {
  ADDRESSING_CHECK_EVENT,
  analyzerNote,
  readAddressingCheck,
} from "./addressing-trace";

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

describe("analyzerNote", () => {
  const record = (source: string | null, reason: string | null = null) => ({
    addressed: true,
    source,
    reason,
    matchedText: null,
    botDisplayName: "Igor",
  });

  it("says nothing when the analyzer decided — its exchange is in the trace", () => {
    expect(analyzerNote(record("analyzer"))).toBeNull();
  });

  it("names the cheap check that decided instead, and that there is nothing to read", () => {
    const note = analyzerNote(record("name"));
    expect(note).toContain("No analyzer was asked");
    expect(note).toContain("matched literally");
    expect(note).toContain("no request or response");
  });

  it("covers every deterministic source", () => {
    for (const source of ["private", "reply", "mention", "command", "name", "task"]) {
      expect(analyzerNote(record(source))).toMatch(/^No analyzer was asked — \w/);
    }
  });

  it("falls back to the recorded reason for a source it does not know", () => {
    expect(analyzerNote(record("something-new", "because reasons"))).toContain(
      "because reasons",
    );
  });

  it("still explains a verdict with neither source nor reason", () => {
    expect(analyzerNote(record(null))).toContain("the deterministic checks settled it");
  });
});
