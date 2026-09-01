import { describe, expect, it } from "vitest";

import { isApiError } from "@/lib/api-error";
import { setupTempTraceStore } from "@/test/trace-store";
import {
  buildTraceBundle,
  buildTraceListBundle,
  getTraceDetail,
  getTraceList,
} from "./service";
import { startTrace, type StartTraceInput } from "./recorder";

/**
 * Shared Debug service over the file-backed store. Docker-free: the store writes
 * to a throwaway trace directory, cleared before every test.
 */

const baseInput: StartTraceInput = {
  feature: "bot-messaging",
  action: "reply",
  trigger: { kind: "telegram", actor: "chat:1" },
  inputSummary: "hello",
};

/** Seed one settled trace and return its id. */
async function seed(overrides: Partial<StartTraceInput> = {}, fail = false): Promise<string> {
  const trace = await startTrace({ ...baseInput, ...overrides });
  await trace.event({ type: "input", message: "received" });
  if (fail) await trace.fail(new Error("boom"));
  else await trace.succeed({ outputSummary: "hi" });
  return trace.id;
}

setupTempTraceStore();

describe("getTraceList", () => {
  it("returns paged headers, total, and the distinct feature list", async () => {
    await seed({ feature: "settings", action: "update" });
    await seed({ feature: "bot-messaging" });
    await seed({ feature: "bot-messaging" }, true);

    const all = await getTraceList({});
    expect(all.total).toBe(3);
    expect(all.traces).toHaveLength(3);
    // Newest first; headers carry no events.
    expect(all.traces[0].events).toEqual([]);
    expect(all.features).toEqual(["bot-messaging", "settings"]);
  });

  it("filters by feature and status", async () => {
    await seed({ feature: "settings" });
    await seed({ feature: "bot-messaging" }, true);

    const errors = await getTraceList({ status: "error" });
    expect(errors.total).toBe(1);
    expect(errors.traces[0].feature).toBe("bot-messaging");

    const settings = await getTraceList({ feature: "settings" });
    expect(settings.total).toBe(1);
    // The feature list reflects everything recorded, not just the filtered slice.
    expect(settings.features).toEqual(["bot-messaging", "settings"]);
  });

  it("returns every trace uncapped when no limit is given", async () => {
    for (let i = 0; i < 55; i++) {
      const trace = await startTrace({ ...baseInput, action: `reply-${i}` });
      await trace.succeed();
    }
    const all = await getTraceList({});
    expect(all.total).toBe(55);
    expect(all.traces).toHaveLength(55);
  });

  it("pages with limit/offset while total still counts the whole match", async () => {
    for (let i = 0; i < 55; i++) {
      const trace = await startTrace({ ...baseInput, action: `reply-${i}` });
      await trace.succeed();
    }

    const first = await getTraceList({ limit: 50, offset: 0 });
    // `total` is what the Debug pagination sizes itself from: a page-sized total
    // would report "1 page" for 55 traces and hide the last five for good.
    expect(first.total).toBe(55);
    expect(first.traces).toHaveLength(50);

    const second = await getTraceList({ limit: 50, offset: 50 });
    expect(second.total).toBe(55);
    expect(second.traces).toHaveLength(5);

    // The two pages are disjoint and cover everything — no row is skipped or
    // repeated at the boundary.
    const ids = new Set([...first.traces, ...second.traces].map((t) => t.id));
    expect(ids.size).toBe(55);
  });

  it("pages a filtered list against the filtered total", async () => {
    for (let i = 0; i < 5; i++) {
      const trace = await startTrace({ ...baseInput, feature: "settings", action: `s-${i}` });
      await trace.succeed();
    }
    await seed({ feature: "bot-messaging" });

    const page = await getTraceList({ feature: "settings", limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.traces).toHaveLength(2);
    expect(page.traces.every((t) => t.feature === "settings")).toBe(true);
  });
});

describe("trace correlation", () => {
  it("stamps every trace with a correlation — its own id when none was given", async () => {
    const trace = await startTrace(baseInput);
    await trace.succeed();
    const detail = await getTraceDetail(trace.id);
    // A single-trace action correlates to itself, so the Debug correlation
    // filter always has something to show (operator requirement, 2026-08-15).
    expect(detail.trigger.correlationId).toBe(trace.id);
  });

  it("keeps an explicit correlation and filters the list by it", async () => {
    const run = { kind: "cron" as const, actor: "memory-extraction", correlationId: "memory:run-1" };
    await seed({ feature: "memory-extraction", trigger: run });
    await seed({ feature: "memory", trigger: { ...run, kind: "system", actor: "memory" } });
    await seed(); // unrelated, self-correlated

    const grouped = await getTraceList({ correlationId: "memory:run-1" });
    expect(grouped.total).toBe(2);
    expect(grouped.traces.every((t) => t.trigger.correlationId === "memory:run-1")).toBe(true);
  });

  it("filters by trigger kind and actor", async () => {
    await seed({ trigger: { kind: "cron", actor: "memory-extraction" } });
    await seed({ trigger: { kind: "cron", actor: "history-summaries" } });
    await seed(); // telegram

    const cron = await getTraceList({ triggerKind: "cron" });
    expect(cron.total).toBe(2);

    const job = await getTraceList({ triggerKind: "cron", actor: "memory-extraction" });
    expect(job.total).toBe(1);
    expect(job.traces[0].trigger.actor).toBe("memory-extraction");
  });
});

describe("getTraceDetail", () => {
  it("returns the full trace with ordered events", async () => {
    const id = await seed();
    const trace = await getTraceDetail(id);
    expect(trace.id).toBe(id);
    expect(trace.events.length).toBeGreaterThan(0);
    expect(trace.events[0].type).toBe("input");
  });

  it("throws a not_found ApiError for an unknown id", async () => {
    const err = await getTraceDetail("missing").catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("not_found");
  });
});

describe("buildTraceBundle", () => {
  it("wraps a single trace (with events) in the shared bundle envelope", async () => {
    const id = await seed();
    const bundle = await buildTraceBundle(id);
    expect(bundle.schema).toBe("assistant-hub/trace-bundle@1");
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0].id).toBe(id);
    expect(bundle.traces[0].events.length).toBeGreaterThan(0);
  });
});

describe("buildTraceListBundle", () => {
  it("bundles the filtered traces, each with its events attached", async () => {
    await seed({ feature: "settings" });
    await seed({ feature: "bot-messaging" });

    const bundle = await buildTraceListBundle({ feature: "bot-messaging" });
    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0].feature).toBe("bot-messaging");
    expect(bundle.traces[0].events.length).toBeGreaterThan(0);
  });
});
