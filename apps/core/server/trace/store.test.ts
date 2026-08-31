import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import type { Trace } from "@/lib/trace";
import { setupTempTraceStore } from "@/test/trace-store";
import {
  __resetTraceStoreForTests,
  flushTracesNow,
  getEventsForTraces,
  getLatestTraceIdsByCorrelation,
  getTrace,
  getTraceStorageHealth,
  listFeatures,
  listTraceMonths,
  listTraces,
  pruneTracesBefore,
  scanTraces,
} from "./store";
import { startTrace, type StartTraceInput } from "./recorder";

/**
 * File-backed trace store + recorder. Docker-free: traces live in memory while
 * mutable and settle to monthly NDJSON logs under a throwaway directory.
 */

const baseInput: StartTraceInput = {
  feature: "bot",
  action: "reply",
  trigger: { kind: "telegram", actor: "chat:1", correlationId: "update:9" },
  inputSummary: "hello",
};

const store = setupTempTraceStore();

/** Read every NDJSON line across the store's month files. */
function readAllLines(): unknown[] {
  const out: unknown[] = [];
  const dir = store.dir;
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!/^traces-\d{4}-\d{2}\.ndjson$/.test(file)) continue;
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

describe("recorder → store", () => {
  it("records a running trace with events and settles as success", async () => {
    const trace = await startTrace(baseInput);

    await trace.event({ type: "input", message: "received message" });
    await trace.event({
      type: "llm_response",
      message: "model replied",
      usage: { model: "m", promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await trace.succeed({ outputSummary: "hi there", relatedIds: { messages: ["m1"] } });

    const stored = await getTrace(trace.id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("success");
    expect(stored!.finishedAt).not.toBeNull();
    expect(stored!.outputSummary).toBe("hi there");
    expect(stored!.relatedIds).toEqual({ messages: ["m1"] });
    expect(stored!.trigger).toEqual({
      kind: "telegram",
      actor: "chat:1",
      correlationId: "update:9",
    });
    expect(stored!.events).toHaveLength(2);
    expect(stored!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(stored!.events[0].type).toBe("input");
    expect(stored!.events[1].usage?.totalTokens).toBe(15);
  });

  it("records failures with an error event and error status", async () => {
    const trace = await startTrace(baseInput);
    await trace.fail(ApiError.serviceUnavailable("LLM down"));

    const stored = await getTrace(trace.id);
    expect(stored!.status).toBe("error");
    expect(stored!.error).toEqual({ code: "service_unavailable", message: "LLM down" });
    const errorEvents = stored!.events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].level).toBe("error");
  });

  it("records the cause chain, where a wrapped failure keeps its real reason", async () => {
    const driverError = new Error('column "reflection" of relation "x" does not exist');
    const trace = await startTrace(baseInput);
    await trace.fail(new Error('Failed query: insert into "x"', { cause: driverError }));

    const stored = await getTrace(trace.id);
    expect(stored!.error!.message).toBe(
      'Failed query: insert into "x"\ncaused by: column "reflection" of relation "x" does not exist',
    );
    expect(stored!.events.find((e) => e.type === "error")!.message).toContain("caused by:");
  });

  it("keeps an ApiError's code while still unwrapping its cause", async () => {
    const trace = await startTrace(baseInput);
    await trace.fail(
      ApiError.serviceUnavailable("LLM is not configured", { cause: new Error("ECONNREFUSED") }),
    );

    const stored = await getTrace(trace.id);
    expect(stored!.error).toEqual({
      code: "service_unavailable",
      message: "LLM is not configured\ncaused by: ECONNREFUSED",
    });
  });

  it("does not repeat a wrapper that only restates its cause, or loop on a cycle", async () => {
    const looping = new Error("boom") as Error & { cause?: unknown };
    looping.cause = looping;
    const trace = await startTrace(baseInput);
    await trace.fail(looping);

    const stored = await getTrace(trace.id);
    expect(stored!.error!.message).toBe("boom");
  });

  it("merges mid-flight related ids with settle-time ones, deduplicated", async () => {
    const trace = await startTrace(baseInput);
    trace.relate("tasks", ["task-1"]);
    trace.relate("tasks", ["task-1", "task-2"]); // duplicate must not double up
    await trace.succeed({ relatedIds: { tasks: ["task-1"], messages: ["m1"] } });

    const stored = await getTrace(trace.id);
    expect(stored!.relatedIds).toEqual({ tasks: ["task-1", "task-2"], messages: ["m1"] });
  });

  it("keeps ids related mid-flight when the trace settles as failed or skipped", async () => {
    // The point of relating up front: a task fire that fails must still be
    // findable by its task id.
    const failed = await startTrace(baseInput);
    failed.relate("tasks", ["task-9"]);
    await failed.fail(new Error("boom"));
    expect((await getTrace(failed.id))!.relatedIds).toEqual({ tasks: ["task-9"] });

    const skipped = await startTrace(baseInput);
    skipped.relate("tasks", ["task-9"]);
    await skipped.skip("nothing to do");
    expect((await getTrace(skipped.id))!.relatedIds).toEqual({ tasks: ["task-9"] });
  });

  it("records skips with a reason", async () => {
    const trace = await startTrace(baseInput);
    await trace.skip("not addressed to bot");

    const stored = await getTrace(trace.id);
    expect(stored!.status).toBe("skipped");
    expect(stored!.outputSummary).toBe("not addressed to bot");
  });

  it("refuses to append or re-settle after settling", async () => {
    const trace = await startTrace(baseInput);
    await trace.succeed();

    await expect(trace.event({ message: "late" })).rejects.toThrow(/already settled/);
    await expect(trace.succeed()).rejects.toThrow(/already settled/);
  });
});

describe("memory-while-mutable + flush", () => {
  it("keeps an open trace in memory and off disk until it settles", async () => {
    const trace = await startTrace(baseInput);
    await trace.event({ message: "step" });

    // Readable while running, but a flush writes nothing (still mutable).
    expect((await getTrace(trace.id))!.status).toBe("running");
    await flushTracesNow();
    expect(readAllLines()).toHaveLength(0);

    await trace.succeed();
    await flushTracesNow();
    const lines = readAllLines() as Array<{ id: string; status: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: trace.id, status: "success" });
  });

  it("still finds a settled trace after it has been flushed out of the pending buffer", async () => {
    const trace = await startTrace(baseInput);
    await trace.succeed({ outputSummary: "done" });
    await flushTracesNow();

    const stored = await getTrace(trace.id);
    expect(stored).not.toBeNull();
    expect(stored!.outputSummary).toBe("done");
  });

  it("reads flushed traces back from the month file after a restart (cold store)", async () => {
    const trace = await startTrace(baseInput);
    await trace.event({ type: "input", message: "received" });
    await trace.succeed({ outputSummary: "persisted" });
    await flushTracesNow();

    // Simulate a process restart: drop the in-memory store; the month file (under
    // the same directory) is all that remains, so a read must warm-load from disk.
    __resetTraceStoreForTests();

    const stored = await getTrace(trace.id);
    expect(stored).not.toBeNull();
    expect(stored!.outputSummary).toBe("persisted");
    expect(stored!.events[0].type).toBe("input");
    expect((await listTraces({})).total).toBe(1);
  });

  it("files a trace under the month of its start instant, not the current month", async () => {
    // A trace can only reach disk once settled, but its month is keyed on start.
    const trace = await startTrace(baseInput);
    await trace.succeed();
    await flushTracesNow();
    const files = readdirSync(store.dir).filter((f) => f.startsWith("traces-"));
    expect(files).toHaveLength(1);
    const month = new Date().toISOString().slice(0, 7);
    expect(files[0]).toBe(`traces-${month}.ndjson`);
  });
});

describe("listTraces / listFeatures", () => {
  it("filters by feature and status, newest first, with total", async () => {
    const a = await startTrace({ ...baseInput, feature: "bot" });
    await a.succeed();
    const b = await startTrace({ ...baseInput, feature: "memory" });
    await b.fail(new Error("boom"));
    const c = await startTrace({ ...baseInput, feature: "bot" });
    await c.succeed();

    const all = await listTraces({});
    expect(all.total).toBe(3);
    expect(all.traces).toHaveLength(3);
    // Headers omit events for list performance.
    expect(all.traces[0].events).toEqual([]);

    const botOnly = await listTraces({ feature: "bot" });
    expect(botOnly.total).toBe(2);
    expect(botOnly.traces.every((t) => t.feature === "bot")).toBe(true);

    const errors = await listTraces({ status: "error" });
    expect(errors.total).toBe(1);
    expect(errors.traces[0].feature).toBe("memory");

    expect(await listFeatures()).toEqual(["bot", "memory"]);
  });

  it("filters by a related row id across tables, in memory and after a flush", async () => {
    const fire = await startTrace({ ...baseInput, feature: "tasks", action: "fire" });
    fire.relate("tasks", ["task-1"]);
    await fire.fail(new Error("delivery down")); // failed runs must match too
    const edit = await startTrace({ ...baseInput, feature: "tasks", action: "update" });
    await edit.succeed({ relatedIds: { tasks: ["task-1"] } });
    const other = await startTrace({ ...baseInput, feature: "tasks", action: "fire" });
    other.relate("tasks", ["task-2"]);
    await other.succeed();
    const unrelated = await startTrace(baseInput);
    await unrelated.succeed();

    const matched = await listTraces({ relatedId: "task-1" });
    expect(matched.total).toBe(2);
    expect(matched.traces.map((t) => t.id).sort()).toEqual([edit.id, fire.id].sort());
    expect((await listTraces({ relatedId: "task-2" })).total).toBe(1);
    expect((await listTraces({ relatedId: "missing" })).total).toBe(0);

    // The filter reads the header tier, so a flushed month must still match.
    await flushTracesNow();
    __resetTraceStoreForTests();
    const cold = await listTraces({ relatedId: "task-1" });
    expect(cold.total).toBe(2);
  });

  it("walks the whole flow from any linked id (turn ↔ record ↔ fires)", async () => {
    // The real shape behind the filter: a reply turn creates a task via a tool,
    // and the task later fires — three processes joined only pairwise (turn
    // correlation on one side, the task's row id on the other).
    const turnCorr = "100:1";
    const reply = await startTrace({
      ...baseInput,
      feature: "bot-messaging",
      trigger: { kind: "telegram", actor: "77", correlationId: turnCorr },
    });
    await reply.succeed();
    const toolCall = await startTrace({
      ...baseInput,
      feature: "mcp-tools-tasks",
      action: "tasks_create",
      trigger: { kind: "telegram", actor: "100", correlationId: turnCorr },
    });
    await toolCall.succeed();
    const create = await startTrace({
      ...baseInput,
      feature: "tasks",
      action: "create",
      trigger: { kind: "telegram", actor: "77", correlationId: turnCorr },
    });
    await create.succeed({ relatedIds: { tasks: ["task-9"] } });
    // The fire opens on the task id and settles correlated to what it sent.
    const fire = await startTrace({
      ...baseInput,
      feature: "tasks",
      action: "fire",
      trigger: { kind: "cron", actor: "100", correlationId: "task-9" },
    });
    fire.relate("tasks", ["task-9"]);
    await fire.succeed({ correlationId: "100:9" });
    const unrelated = await startTrace(baseInput);
    await unrelated.succeed();

    const story = [reply.id, toolCall.id, create.id, fire.id].sort();
    // From the fire's settled correlation (what the operator clicks on the
    // fire's Debug page) all the way back to the turn that created the task.
    const fromFire = await listTraces({ flow: "100:9" });
    expect(fromFire.traces.map((t) => t.id).sort()).toEqual(story);
    // From the creation turn forward to the fire.
    const fromTurn = await listTraces({ flow: turnCorr });
    expect(fromTurn.traces.map((t) => t.id).sort()).toEqual(story);
    // A bare trace id and the record id are valid seeds too.
    expect((await listTraces({ flow: create.id })).traces.map((t) => t.id).sort()).toEqual(story);
    expect((await listTraces({ flow: "task-9" })).traces.map((t) => t.id).sort()).toEqual(story);
    // Other filters narrow within the flow.
    const tasksOnly = await listTraces({ flow: "task-9", feature: "tasks" });
    expect(tasksOnly.traces.map((t) => t.id).sort()).toEqual([create.id, fire.id].sort());
    // An unknown seed matches nothing.
    expect((await listTraces({ flow: "missing" })).total).toBe(0);
  });

  it("applies limit and offset, and unions memory with flushed traces", async () => {
    for (let i = 0; i < 3; i++) {
      const t = await startTrace(baseInput);
      await t.succeed();
    }
    await flushTracesNow(); // 3 on disk
    for (let i = 0; i < 2; i++) {
      const t = await startTrace(baseInput);
      await t.succeed();
    }
    // 2 still pending in memory + 3 flushed = 5.
    const page = await listTraces({ limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.traces).toHaveLength(2);
  });
});

/** A settled trace line for a synthetic month file. */
function traceLine(id: string, startedAt: string, feature = "bot"): Trace {
  return {
    id,
    feature,
    action: "reply",
    status: "success",
    trigger: { kind: "telegram", correlationId: `corr:${id}` },
    startedAt,
    finishedAt: startedAt,
    error: null,
    events: [
      {
        id: `${id}-e0`,
        traceId: id,
        seq: 0,
        ts: startedAt,
        type: "input",
        level: "info",
        message: `event of ${id}`,
      },
      {
        id: `${id}-e1`,
        traceId: id,
        seq: 1,
        ts: startedAt,
        type: "llm_response",
        level: "info",
        message: "model replied",
        usage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ],
  };
}

/** Write one `traces-YYYY-MM.ndjson` file directly (a cold multi-month corpus). */
function writeMonthFile(dir: string, monthKey: string, traces: Trace[]): void {
  writeFileSync(
    path.join(dir, `traces-${monthKey}.ndjson`),
    traces.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
}

describe("multi-month corpus (range + eviction)", () => {
  /** Six months, two traces each, ids like `2026-01-a`. */
  function seedSixMonths(dir: string): void {
    for (let m = 1; m <= 6; m++) {
      const month = `2026-${String(m).padStart(2, "0")}`;
      writeMonthFile(dir, month, [
        traceLine(`${month}-a`, `${month}-10T08:00:00.000Z`),
        traceLine(`${month}-b`, `${month}-20T09:30:00.000Z`),
      ]);
    }
    __resetTraceStoreForTests(); // cold store: everything must come from disk
  }

  it("scans only the months a range intersects, and honors the bounds", async () => {
    seedSixMonths(store.dir);
    const scanned = await scanTraces({
      startUtc: new Date("2026-02-15T00:00:00.000Z"),
      endUtc: new Date("2026-04-15T00:00:00.000Z"),
    });
    expect(scanned.map((t) => t.id).sort()).toEqual([
      "2026-02-b",
      "2026-03-a",
      "2026-03-b",
      "2026-04-a",
    ]);
    // The scan carries events — the analytics contract.
    expect(scanned.every((t) => t.events.length === 2)).toBe(true);
  });

  it("keeps every trace findable with events even after full-month eviction", async () => {
    seedSixMonths(store.dir);
    // An unbounded scan loads all six months full; only the most recent few may
    // keep events cached — but a later read of an evicted month must reload it.
    const all = await scanTraces({});
    expect(all).toHaveLength(12);
    const jan = await getTrace("2026-01-a");
    expect(jan).not.toBeNull();
    expect(jan!.events.map((e) => e.message)).toEqual([
      "event of 2026-01-a",
      "model replied",
    ]);
  });

  it("lists the whole corpus as headers, newest first, and pages across months", async () => {
    seedSixMonths(store.dir);
    const all = await listTraces({});
    expect(all.total).toBe(12);
    expect(all.traces[0].id).toBe("2026-06-b");
    expect(all.traces.at(-1)!.id).toBe("2026-01-a");
    expect(all.traces.every((t) => t.events.length === 0)).toBe(true);

    const page = await listTraces({ limit: 3, offset: 10 });
    expect(page.total).toBe(12);
    expect(page.traces.map((t) => t.id)).toEqual(["2026-01-b", "2026-01-a"]);
  });

  it("bundles events across more months than the full cache can hold at once", async () => {
    seedSixMonths(store.dir);
    const ids = ["2026-01-a", "2026-02-a", "2026-03-a", "2026-04-a", "2026-05-a", "2026-06-a"];
    const grouped = await getEventsForTraces(ids);
    expect(grouped.size).toBe(6);
    for (const id of ids) {
      expect(grouped.get(id)?.map((e) => e.message)).toEqual([`event of ${id}`, "model replied"]);
    }
  });
});

describe("directory-listing cache", () => {
  /**
   * The cached month listing is the whole point of the header index — a list
   * read must not `readdir` per request — but a cache that misses a month
   * created *after* it was built would silently hide traces. Only this process
   * writes the directory, and each of its three writers has to say so.
   */
  it("sees a month created by a flush after the listing was cached", async () => {
    // Warm the cache against an empty directory.
    expect(await listTraceMonths()).toEqual([]);
    expect((await listTraces({})).total).toBe(0);

    const trace = await startTrace(baseInput);
    await trace.succeed();
    await flushTracesNow();

    const month = new Date().toISOString().slice(0, 7);
    expect(await listTraceMonths()).toEqual([month]);
    const all = await listTraces({});
    expect(all.total).toBe(1);
    expect(all.traces[0].id).toBe(trace.id);
  });

  it("sees the month file the storage-health probe creates", async () => {
    expect(await listTraceMonths()).toEqual([]);
    // The probe appends zero bytes, which creates the file when the month is new.
    const health = await getTraceStorageHealth();
    expect(health.ok).toBe(true);
    expect(await listTraceMonths()).toEqual([new Date().toISOString().slice(0, 7)]);
  });

  it("re-reads the directory after a prune deleted files", async () => {
    writeMonthFile(store.dir, "2026-01", [traceLine("2026-01-a", "2026-01-10T08:00:00.000Z")]);
    writeMonthFile(store.dir, "2026-02", [traceLine("2026-02-a", "2026-02-10T08:00:00.000Z")]);
    __resetTraceStoreForTests();

    expect(await listTraceMonths()).toEqual(["2026-01", "2026-02"]);
    await pruneTracesBefore("2026-02");
    expect(await listTraceMonths()).toEqual(["2026-02"]);
  });
});

describe("pruneTracesBefore (manual prune)", () => {
  /** Four months, two traces each, ids like `2026-01-a` — cold store. */
  function seedFourMonths(): void {
    for (let m = 1; m <= 4; m++) {
      const month = `2026-${String(m).padStart(2, "0")}`;
      writeMonthFile(store.dir, month, [
        traceLine(`${month}-a`, `${month}-10T08:00:00.000Z`),
        traceLine(`${month}-b`, `${month}-20T09:30:00.000Z`),
      ]);
    }
    __resetTraceStoreForTests();
  }

  it("deletes files, cache, and correlation entries strictly before the cutoff", async () => {
    seedFourMonths();
    const result = await pruneTracesBefore("2026-03");
    expect(result).toEqual({ months: ["2026-01", "2026-02"], traces: 4 });

    // Files are gone; the kept months still list and read with events.
    expect(await listTraceMonths()).toEqual(["2026-03", "2026-04"]);
    const all = await listTraces({});
    expect(all.total).toBe(4);
    expect(await getTrace("2026-01-a")).toBeNull();
    expect((await getTrace("2026-03-a"))!.events).toHaveLength(2);

    // The pruned traces' correlation entries are gone too.
    const latest = await getLatestTraceIdsByCorrelation(["corr:2026-01-a", "corr:2026-03-a"]);
    expect(latest.get("corr:2026-01-a")).toBeUndefined();
    expect(latest.get("corr:2026-03-a")).toBeDefined();

    // Idempotent: a re-run finds nothing left to delete.
    expect(await pruneTracesBefore("2026-03")).toEqual({ months: [], traces: 0 });
  });

  it("prunes a warmed cache correctly and never touches unflushed traces", async () => {
    seedFourMonths();
    await scanTraces({}); // load every month, full tier
    const open = await startTrace(baseInput); // running: RAM only, not on disk

    const result = await pruneTracesBefore("2026-04");
    expect(result.months).toEqual(["2026-01", "2026-02", "2026-03"]);

    const all = await listTraces({});
    // The kept month's pair plus the still-open trace.
    expect(all.total).toBe(3);
    expect(await getTrace(open.id)).not.toBeNull();
    await open.succeed();
  });

  it("cannot delete the newest month: pruning before it leaves it whole", async () => {
    seedFourMonths();
    await pruneTracesBefore("2026-04");
    const kept = await listTraces({});
    expect(kept.traces.map((t) => t.id).sort()).toEqual(["2026-04-a", "2026-04-b"]);
  });
});

describe("getLatestTraceIdsByCorrelation", () => {
  it("returns the newest trace per correlation id, filtered by feature", async () => {
    const older = await startTrace({
      ...baseInput,
      feature: "bot-messaging",
      trigger: { kind: "telegram", correlationId: "c:1" },
    });
    await older.succeed();
    const newer = await startTrace({
      ...baseInput,
      feature: "bot-messaging",
      trigger: { kind: "telegram", correlationId: "c:1" },
    });
    await newer.succeed();
    // A different feature keyed on the same message must not win the scoped lookup.
    const feedback = await startTrace({
      ...baseInput,
      feature: "user-feedback",
      trigger: { kind: "telegram", correlationId: "c:1" },
    });
    await feedback.succeed();

    const scoped = await getLatestTraceIdsByCorrelation(["c:1"], { features: ["bot-messaging"] });
    expect(scoped.get("c:1")).toBe(newer.id);

    const unscoped = await getLatestTraceIdsByCorrelation(["c:1"]);
    expect(unscoped.get("c:1")).toBe(feedback.id);

    expect((await getLatestTraceIdsByCorrelation(["missing"])).size).toBe(0);
  });
});

describe("trace storage health", () => {
  const currentMonthFile = () =>
    path.join(store.dir, `traces-${new Date().toISOString().slice(0, 7)}.ndjson`);

  it("reports ok against a writable directory", async () => {
    const health = await getTraceStorageHealth();
    expect(health.ok).toBe(true);
    expect(health.detail).toBe(store.dir);
    expect(health.pendingCount).toBe(0);
    expect(health.lastFlushError).toBeNull();
  });

  it("keeps a failed flush pending, reports the failure, and recovers once writable", async () => {
    const trace = await startTrace(baseInput);
    await trace.succeed();

    // Block the write path portably: the month file's path is occupied by a
    // directory, so append fails the same way an unwritable volume does.
    mkdirSync(currentMonthFile());
    await flushTracesNow();

    let health = await getTraceStorageHealth();
    expect(health.ok).toBe(false);
    expect(health.pendingCount).toBe(1);
    expect(health.lastFlushError).not.toBeNull();
    expect(health.detail).toBe(health.lastFlushError!.message);
    // Nothing was lost: the settled trace is still readable from the buffer.
    expect(await getTrace(trace.id)).not.toBeNull();

    // Fix the path; the next health read retries the flush and reports recovery.
    rmdirSync(currentMonthFile());
    health = await getTraceStorageHealth();
    expect(health.ok).toBe(true);
    expect(health.pendingCount).toBe(0);
    expect(health.lastFlushError).toBeNull();
    expect(readAllLines()).toHaveLength(1);
  });

  it("keeps the FIRST failure instant while the same failure persists", async () => {
    const trace = await startTrace(baseInput);
    await trace.succeed();
    mkdirSync(currentMonthFile());

    await flushTracesNow();
    const first = (await getTraceStorageHealth()).lastFlushError!.at;

    // A later retry of the same failure must not move "failing since".
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flushTracesNow();
    expect((await getTraceStorageHealth()).lastFlushError!.at).toBe(first);

    rmdirSync(currentMonthFile());
  });
});

/**
 * The assistant a traced action belonged to: recorded on the trace, survives
 * the round trip to disk, and filters the list — so Debug can answer "what has
 * Anna been doing" (operator request, 2026-08-25).
 */
describe("assistant scoping", () => {
  it("records the assistant, keeps it through a flush, and filters by it", async () => {
    const hers = await startTrace({ ...baseInput, assistantId: "assistant-a" });
    await hers.succeed();
    const his = await startTrace({ ...baseInput, assistantId: "assistant-b" });
    await his.succeed();
    // Nobody's in particular — a background job.
    const nobodys = await startTrace({ ...baseInput, feature: "history-index" });
    await nobodys.succeed();

    expect((await listTraces({ assistantId: "assistant-a" })).total).toBe(1);
    expect((await listTraces({ assistantId: "assistant-a" })).traces[0].id).toBe(hers.id);
    // An unstamped trace belongs to no assistant, so it is in no assistant's view.
    expect((await listTraces({ assistantId: "assistant-b" })).total).toBe(1);
    expect((await listTraces({})).total).toBe(3);

    // The set filter (Phase 9 user scoping): only the named assistants'
    // traces, unstamped ones excluded; both single and set filters compose.
    expect((await listTraces({ assistantIdIn: ["assistant-a", "assistant-b"] })).total).toBe(2);
    expect((await listTraces({ assistantIdIn: ["assistant-a"] })).total).toBe(1);
    expect((await listTraces({ assistantIdIn: [] })).total).toBe(0);
    expect(
      (await listTraces({ assistantId: "assistant-b", assistantIdIn: ["assistant-a"] })).total,
    ).toBe(0);

    await flushTracesNow();
    __resetTraceStoreForTests();
    // Survives the round trip to disk — the filter is not an in-memory trick.
    const reloaded = await listTraces({ assistantId: "assistant-a" });
    expect(reloaded.total).toBe(1);
    expect(reloaded.traces[0].assistantId).toBe("assistant-a");
    expect((await getTrace(hers.id))!.assistantId).toBe("assistant-a");
  });

  it("combines with the other filters rather than replacing them", async () => {
    const replied = await startTrace({ ...baseInput, assistantId: "assistant-a" });
    await replied.succeed();
    const failed = await startTrace({ ...baseInput, assistantId: "assistant-a" });
    await failed.fail(new Error("nope"));

    expect((await listTraces({ assistantId: "assistant-a", status: "error" })).total).toBe(1);
    expect((await listTraces({ assistantId: "assistant-a", status: "error" })).traces[0].id).toBe(
      failed.id,
    );
    expect((await listTraces({ assistantId: "assistant-b", status: "error" })).total).toBe(0);
  });
});
