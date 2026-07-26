import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, type TestDb } from "@/test/db";

import { listEngineStats, recordEngineOutcome } from "./engine-stats";

/**
 * The search scoreboard against a real Postgres. The upsert is the load-bearing
 * part — an engine has no row until the first time it is tried, and every later
 * attempt must add to that row rather than replace it — and so is the decay, which
 * is what keeps a long-dead engine's record from freezing the ranking forever.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

/** Read one engine's row (the list is sorted, so find by name). */
async function statFor(engine: string) {
  return (await listEngineStats(ctx.db)).find((row) => row.engine === engine);
}

describe("search engine scoreboard", () => {
  it("creates a row the first time an engine is tried", async () => {
    await recordEngineOutcome("Bing", true, undefined, ctx.db);

    const stat = await statFor("Bing");
    expect(stat).toMatchObject({ engine: "Bing", successes: 1, failures: 0 });
    expect(stat?.lastSuccessAt).not.toBeNull();
    expect(stat?.lastFailureAt).toBeNull();
  });

  it("accumulates outcomes instead of overwriting them", async () => {
    await recordEngineOutcome("Bing", true, undefined, ctx.db);
    await recordEngineOutcome("Bing", false, "captcha", ctx.db);
    await recordEngineOutcome("Bing", true, undefined, ctx.db);

    expect(await statFor("Bing")).toMatchObject({ successes: 2, failures: 1 });
  });

  it("keeps the last failure's reason — the operator's first clue — past a later success", async () => {
    await recordEngineOutcome("Google", false, "captcha at /sorry/index", ctx.db);
    expect((await statFor("Google"))?.lastError).toContain("captcha");

    await recordEngineOutcome("Google", true, undefined, ctx.db);
    const recovered = await statFor("Google");
    // Still readable after it starts working again: "what went wrong last time"
    // outlives the recovery, and the timestamps say which came later.
    expect(recovered?.lastError).toContain("captcha");
    expect(recovered?.lastSuccessAt).not.toBeNull();
  });

  it("ranks the scoreboard best-first", async () => {
    for (let i = 0; i < 5; i++) await recordEngineOutcome("Bing", true, undefined, ctx.db);
    for (let i = 0; i < 5; i++) await recordEngineOutcome("DuckDuckGo", false, "blocked", ctx.db);

    expect((await listEngineStats(ctx.db)).map((row) => row.engine)).toEqual([
      "Bing",
      "DuckDuckGo",
    ]);
  });

  it("halves the counters once the record is long, so the ranking stays reactive", async () => {
    // 101 attempts crosses the decay threshold; the row must not just keep growing.
    for (let i = 0; i < 101; i++) await recordEngineOutcome("Bing", true, undefined, ctx.db);

    const stat = await statFor("Bing");
    expect(stat!.successes).toBeLessThan(101);
    expect(stat!.successes).toBeGreaterThan(0);
    // Still overwhelmingly successful — decay must not distort the verdict.
    expect(stat!.successRate).toBeGreaterThan(0.9);
  });

  it("never throws on a write it cannot make", async () => {
    // A scoreboard failure must not fail a search that already worked.
    const broken = { insert: () => { throw new Error("db is gone"); } } as never;
    await expect(recordEngineOutcome("Bing", true, undefined, broken)).resolves.toBeUndefined();
  });
});
