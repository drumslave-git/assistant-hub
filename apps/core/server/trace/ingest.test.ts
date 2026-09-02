import { describe, expect, it } from "vitest";

import type { SourceTrace } from "@assistant-hub/contracts";

import { setupTempTraceStore } from "@/test/trace-store";
import { ingestSourceTrace } from "./ingest";
import { getTraceDetail, getTraceList } from "./service";

/**
 * The unified trace store's ingest half: a source app's settled trace lands
 * in the same store locally recorded traces do — the debug explorer reads
 * one place, and the source's own timestamps and correlation survive.
 */

setupTempTraceStore();

function sourceTrace(over: Partial<SourceTrace> = {}): SourceTrace {
  return {
    feature: "bot-messaging",
    action: "deliver",
    status: "success",
    trigger: { kind: "transport", actor: "-500", correlationId: "-500:7" },
    startedAt: "2026-08-24T10:00:00.000Z",
    finishedAt: "2026-08-24T10:00:01.000Z",
    inputSummary: "the reply text",
    outputSummary: "delivered -500:41",
    error: null,
    events: [
      {
        seq: 0,
        ts: "2026-08-24T10:00:00.500Z",
        type: "external_call",
        level: "success",
        message: "reply sent",
        data: { messageId: 41 },
      },
    ],
    ...over,
  };
}

describe("ingestSourceTrace", () => {
  it("persists the trace as settled, with the source's timeline intact", async () => {
    ingestSourceTrace(sourceTrace());

    const list = await getTraceList({});
    expect(list.total).toBe(1);
    const detail = await getTraceDetail(list.traces[0].id);
    expect(detail).toMatchObject({
      feature: "bot-messaging",
      action: "deliver",
      status: "success",
      startedAt: "2026-08-24T10:00:00.000Z",
      finishedAt: "2026-08-24T10:00:01.000Z",
      inputSummary: "the reply text",
      outputSummary: "delivered -500:41",
      trigger: { kind: "transport", actor: "-500", correlationId: "-500:7" },
    });
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]).toMatchObject({
      seq: 0,
      ts: "2026-08-24T10:00:00.500Z",
      type: "external_call",
      level: "success",
      message: "reply sent",
      data: { messageId: 41 },
    });
  });

  it("keeps a failed source trace filterable by its correlation", async () => {
    ingestSourceTrace(
      sourceTrace({
        status: "error",
        error: { message: "403: bot was blocked" },
        outputSummary: undefined,
      }),
    );

    const byCorrelation = await getTraceList({ correlationId: "-500:7" });
    expect(byCorrelation.total).toBe(1);
    expect(byCorrelation.traces[0]).toMatchObject({ status: "error" });
    const detail = await getTraceDetail(byCorrelation.traces[0].id);
    expect(detail?.error).toEqual({ message: "403: bot was blocked" });
  });
});

describe("ingestSourceTrace — assistant scoping", () => {
  it("carries the source's assistant onto the stored trace, so Debug can filter it", async () => {
    // tg stamps the connection's assistant on inbound / delivery / feedback
    // traces; the cross-app flow must stay filterable by whose bot it was.
    ingestSourceTrace(sourceTrace({ assistantId: "assistant-a" }));
    ingestSourceTrace(sourceTrace({ assistantId: "assistant-b", trigger: { kind: "transport" } }));

    const mine = await getTraceList({ assistantId: "assistant-a" });
    expect(mine.total).toBe(1);
    expect(mine.traces[0].assistantId).toBe("assistant-a");
    expect((await getTraceList({})).total).toBe(2);
  });

  it("leaves a trace no assistant owns unstamped", async () => {
    ingestSourceTrace(sourceTrace());
    const [trace] = (await getTraceList({})).traces;
    expect(trace.assistantId).toBeUndefined();
  });
});
