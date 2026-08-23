import { describe, expect, it } from "vitest";

import {
  createSourceTraceRecorder,
  traceRecordedEventSchema,
  type TraceRecordedEvent,
} from "./trace";

/**
 * The source-side trace recorder: buffers locally, publishes exactly one
 * valid `trace.recorded` event on settle — and nothing at all for an
 * action that never settles (the noise rule callers lean on).
 */

function client() {
  const published: TraceRecordedEvent[] = [];
  const traces = createSourceTraceRecorder({
    source: "tg",
    publish: async (event) => {
      published.push(event);
    },
  });
  return { published, traces };
}

describe("createSourceTraceRecorder", () => {
  it("publishes one schema-valid event carrying the buffered timeline", async () => {
    const { published, traces } = client();
    const trace = traces.startTrace({
      feature: "bot-messaging",
      action: "inbound",
      trigger: { kind: "telegram", actor: "100", correlationId: "-500:7" },
      inputSummary: "hello",
    });
    trace.event({ message: "mirrored", type: "db" });
    trace.event({ message: "enqueued", type: "output", level: "success", data: { n: 1 } });
    await trace.succeed({ outputSummary: "enqueued for the core" });

    expect(published).toHaveLength(1);
    const event = traceRecordedEventSchema.parse(published[0]);
    expect(event.source).toBe("tg");
    expect(event.correlationId).toBe("-500:7");
    expect(event.trace).toMatchObject({
      feature: "bot-messaging",
      action: "inbound",
      status: "success",
      inputSummary: "hello",
      outputSummary: "enqueued for the core",
      error: null,
    });
    expect(event.trace.events.map((e) => [e.seq, e.message])).toEqual([
      [0, "mirrored"],
      [1, "enqueued"],
    ]);
  });

  it("publishes nothing for a recorder that never settles", async () => {
    const { published, traces } = client();
    const trace = traces.startTrace({
      feature: "bot-messaging",
      action: "inbound",
      trigger: { kind: "telegram" },
    });
    trace.event({ message: "mirrored" });
    expect(published).toHaveLength(0);
  });

  it("settles once — a second settle is ignored", async () => {
    const { published, traces } = client();
    const trace = traces.startTrace({
      feature: "bot-messaging",
      action: "inbound",
      trigger: { kind: "telegram" },
    });
    await trace.succeed();
    await trace.fail(new Error("late"));
    expect(published).toHaveLength(1);
    expect(published[0].trace.status).toBe("success");
  });

  it("records the failure as the last event and settles as error", async () => {
    const { published, traces } = client();
    const trace = traces.startTrace({
      feature: "self-improvement",
      action: "collect-feedback",
      trigger: { kind: "telegram", correlationId: "-500:9" },
    });
    await trace.fail(new Error("menu send refused"));

    expect(published[0].trace.status).toBe("error");
    expect(published[0].trace.error).toEqual({ message: "menu send refused" });
    const last = published[0].trace.events.at(-1);
    expect(last).toMatchObject({ type: "error", level: "error", message: "menu send refused" });
  });

  it("invents a correlation when the action has none, and honours a settle-time one", async () => {
    const { published, traces } = client();
    await traces
      .startTrace({ feature: "f", action: "a", trigger: { kind: "system" } })
      .succeed();
    expect(published[0].correlationId).toBeTruthy();
    expect(published[0].trace.trigger.correlationId).toBe(published[0].correlationId);

    await traces
      .startTrace({ feature: "f", action: "a", trigger: { kind: "telegram" } })
      .succeed({ correlationId: "-500:41" });
    expect(published[1].correlationId).toBe("-500:41");
  });
});
