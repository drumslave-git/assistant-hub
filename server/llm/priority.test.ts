import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_INTERACTIVE_IN_FLIGHT,
  resetLlmPriorityGateForTests,
  withLlmPriority,
} from "./priority";

/** A run() the test resolves by hand, recording when it started. */
function controllable(label: string, started: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = async (): Promise<string> => {
    started.push(label);
    await gate;
    return label;
  };
  return { run, release };
}

/** Let queued microtasks/promise chains settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetLlmPriorityGateForTests();
});

describe("withLlmPriority", () => {
  it("runs interactive calls immediately, even while another is in flight", async () => {
    const started: string[] = [];
    const a = controllable("a", started);
    const b = controllable("b", started);
    const pa = withLlmPriority("interactive", a.run);
    const pb = withLlmPriority("interactive", b.run);
    await settle();
    expect(started).toEqual(["a", "b"]);
    a.release();
    b.release();
    await expect(Promise.all([pa, pb])).resolves.toEqual(["a", "b"]);
  });

  it("holds a background call while an interactive call is in flight", async () => {
    const started: string[] = [];
    const reply = controllable("reply", started);
    const job = controllable("job", started);
    const pReply = withLlmPriority("interactive", reply.run);
    const pJob = withLlmPriority("background", job.run);
    await settle();
    expect(started).toEqual(["reply"]);

    reply.release();
    await settle();
    expect(started).toEqual(["reply", "job"]);
    job.release();
    await expect(Promise.all([pReply, pJob])).resolves.toEqual(["reply", "job"]);
  });

  it("runs at most one background call at a time, in arrival order", async () => {
    const started: string[] = [];
    const one = controllable("one", started);
    const two = controllable("two", started);
    const three = controllable("three", started);
    const p1 = withLlmPriority("background", one.run);
    const p2 = withLlmPriority("background", two.run);
    const p3 = withLlmPriority("background", three.run);
    await settle();
    expect(started).toEqual(["one"]);

    one.release();
    await settle();
    expect(started).toEqual(["one", "two"]);

    two.release();
    await settle();
    expect(started).toEqual(["one", "two", "three"]);
    three.release();
    await Promise.all([p1, p2, p3]);
  });

  it("lets an interactive call dispatch while a background call is on the wire", async () => {
    const started: string[] = [];
    const job = controllable("job", started);
    const reply = controllable("reply", started);
    const pJob = withLlmPriority("background", job.run);
    await settle();
    const pReply = withLlmPriority("interactive", reply.run);
    await settle();
    // No preemption, but no waiting either: both are on the wire.
    expect(started).toEqual(["job", "reply"]);
    job.release();
    reply.release();
    await Promise.all([pJob, pReply]);
  });

  it("keeps background work waiting until every interactive call has finished", async () => {
    const started: string[] = [];
    const a = controllable("a", started);
    const b = controllable("b", started);
    const job = controllable("job", started);
    const pa = withLlmPriority("interactive", a.run);
    const pb = withLlmPriority("interactive", b.run);
    const pJob = withLlmPriority("background", job.run);
    await settle();
    a.release();
    await settle();
    // One interactive call is still in flight — the job keeps waiting.
    expect(started).toEqual(["a", "b"]);
    b.release();
    await settle();
    expect(started).toEqual(["a", "b", "job"]);
    job.release();
    await Promise.all([pa, pb, pJob]);
  });

  it("releases the slot when a call throws, and surfaces the error", async () => {
    const started: string[] = [];
    const job = controllable("job", started);
    const boom = withLlmPriority("interactive", async () => {
      throw new Error("provider down");
    });
    const pJob = withLlmPriority("background", job.run);
    await expect(boom).rejects.toThrow("provider down");
    await settle();
    expect(started).toEqual(["job"]);
    job.release();
    await pJob;
  });

  it("releases the background slot when a background call throws", async () => {
    const failing = withLlmPriority("background", async () => {
      throw new Error("bad batch");
    });
    await expect(failing).rejects.toThrow("bad batch");
    const started: string[] = [];
    const next = controllable("next", started);
    const pNext = withLlmPriority("background", next.run);
    await settle();
    expect(started).toEqual(["next"]);
    next.release();
    await pNext;
  });
});

describe("interactive concurrency cap", () => {
  /** A call that parks until released, so overlap is observable. */
  function gated() {
    let release!: () => void;
    const started = { yes: false };
    const promise = new Promise<void>((r) => (release = r));
    return {
      release,
      started,
      run: async () => {
        started.yes = true;
        await promise;
      },
    };
  }

  it("runs up to the cap at once and holds the rest back", async () => {
    resetLlmPriorityGateForTests();
    const calls = Array.from({ length: MAX_INTERACTIVE_IN_FLIGHT + 2 }, gated);
    const running = calls.map((c) => withLlmPriority("interactive", c.run));
    await Promise.resolve();
    await Promise.resolve();

    // Exactly the cap started; the surplus is parked in RAM, not on the wire.
    expect(calls.filter((c) => c.started.yes)).toHaveLength(MAX_INTERACTIVE_IN_FLIGHT);

    calls[0].release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.started.yes)).toHaveLength(MAX_INTERACTIVE_IN_FLIGHT + 1);

    calls.forEach((c) => c.release());
    await Promise.all(running);
  });

  it("wakes a queued interactive call before any background one", async () => {
    resetLlmPriorityGateForTests();
    const busy = Array.from({ length: MAX_INTERACTIVE_IN_FLIGHT }, gated);
    const running = busy.map((c) => withLlmPriority("interactive", c.run));

    const order: string[] = [];
    // Background queues first — and must still lose, because priority here is
    // structural rather than first-come.
    const bg = withLlmPriority("background", async () => void order.push("background"));
    const queued = withLlmPriority("interactive", async () => void order.push("interactive"));

    busy.forEach((c) => c.release());
    await Promise.all([...running, queued, bg]);
    expect(order).toEqual(["interactive", "background"]);
  });
});
