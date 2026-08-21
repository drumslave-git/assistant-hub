import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DrizzleDb } from "@/db/drizzle";
import * as schema from "@/db/schema";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { barrier, deferred } from "@/test/async";
import { startTestDb, type TestDb } from "@/test/db";

/**
 * Cross-process advisory-lock contention (IMPROVEMENTS §12.1). The lock exists
 * to stop two *server instances* (e.g. briefly co-existing during a redeploy)
 * from double-running a job, so these tests contend from two separate `pg`
 * pools against one Postgres — each pool standing in for one process. The
 * same-pool nesting case lives in the vision backfill integration test; this
 * file covers the scenario the lock was actually built for.
 */

let ctx: TestDb;
let poolB: Pool;
let dbB: DrizzleDb;

beforeAll(async () => {
  ctx = await startTestDb();
  poolB = new Pool({ connectionString: ctx.connectionUri });
  dbB = drizzle(poolB, { schema });
});

afterAll(async () => {
  await poolB?.end();
  await ctx?.stop();
});

describe("withAdvisoryLock across separate pools", () => {
  it("skips the second holder while the first holds, and re-acquires after release", async () => {
    const held = deferred();
    const release = deferred();

    // Scheduler A (pool A) takes the lock and sits inside its job.
    const holder = withAdvisoryLock(
      "contended-job",
      async () => {
        held.resolve();
        await release.promise;
        return "first";
      },
      ctx.db,
    );
    await held.promise;

    // Scheduler B (pool B) contends while A holds: benign skip, fn never runs.
    const fn = vi.fn(async () => "second");
    const contender = await withAdvisoryLock("contended-job", fn, dbB);
    expect(contender.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();

    release.resolve();
    await expect(holder).resolves.toEqual({ ran: true, result: "first" });

    // A released → B's next tick acquires from its own pool.
    const retry = await withAdvisoryLock("contended-job", fn, dbB);
    expect(retry).toEqual({ ran: true, result: "second" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lets exactly one of two simultaneous contenders run", async () => {
    // Both schedulers fire on the same tick. The winner blocks inside its job on
    // the gate, so the loser must settle first — and must settle as a skip.
    const gate = deferred();
    const attempt = (db: DrizzleDb) =>
      withAdvisoryLock(
        "race-job",
        async () => {
          await gate.promise;
          return true;
        },
        db,
      );
    const a = attempt(ctx.db);
    const b = attempt(dbB);

    const loser = await Promise.race([a, b]);
    expect(loser.ran).toBe(false);

    gate.resolve();
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });

  it("does not contend across different job names", async () => {
    // Both jobs must be inside their fn at the same time — if the derived keys
    // collided, one would have skipped and the barrier would never release.
    const bothRunning = barrier(2);
    const run = (name: string, db: DrizzleDb) =>
      withAdvisoryLock(
        name,
        async () => {
          await bothRunning();
          return name;
        },
        db,
      );

    const [a, b] = await Promise.all([run("job-a", ctx.db), run("job-b", dbB)]);
    expect(a).toEqual({ ran: true, result: "job-a" });
    expect(b).toEqual({ ran: true, result: "job-b" });
  });
});
