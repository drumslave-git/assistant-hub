import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatCompletionResult } from "@/server/llm/client";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { listTraces } from "@/server/trace";
import { seedSourceMessage, startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { registerTestTransport } from "@/test/transports";

import { sourceMedia } from "../../../store/schema";

import { runVisionBackfill, type VisionBackfillSource } from "./backfill";
import { countPendingMedia, insertMedia, listPendingMedia } from "./repository";
import { dbMediaStore } from "./service";

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  // The media sources are the registered transports — the roster is empty
  // after a truncate, so the fixture transport announces itself first.
  await registerTestTransport(ctx.db);
});

async function seedPending(
  sourceMessageId: number,
  chatId = "5",
  over?: { processed?: boolean },
) {
  // Media rows require their mirrored message (FK) — mirror first, like the pipeline.
  await seedSourceMessage(ctx, { chatId, sourceMessageId, processed: over?.processed });
  return insertMedia(ctx.db, {
    id: crypto.randomUUID(),
    source: "tg",
    chatId,
    sourceMessageId: String(sourceMessageId),
    kind: "photo",
    fileId: `file-${sourceMessageId}`,
    fileUniqueId: `u${sourceMessageId}`,
    mimeType: "image/jpeg",
    dataBase64: "QUJD",
    visionHint: null,
  });
}

/** The source seam over this test's database — what the tg API provides live. */
function source(): VisionBackfillSource {
  return {
    source: "tg",
    store: dbMediaStore(ctx.db, "tg"),
    listPending: (limit) => listPendingMedia(ctx.db, "tg", limit),
    countPending: () => countPendingMedia(ctx.db, "tg"),
  };
}

function fakeComplete(content: string): ChatCompletionResult {
  return {
    content,
    model: "vision-model",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 12,
    requestBody: {},
    responseBody: {},
  };
}

describe("runVisionBackfill", () => {
  it("describes every pending row, drops bytes, and records a run trace", async () => {
    await seedPending(10);
    await seedPending(11);
    await seedPending(12);

    const result = await runVisionBackfill(
      { complete: async () => fakeComplete("a photo") },
      source(),
      {},
      ctx.db,
    );

    expect(result.described).toBe(3);
    expect(result.unresolved).toBe(0);
    expect(result.interrupted).toBe(false);
    expect(await countPendingMedia(ctx.db, "tg")).toBe(0);

    // The batch run is traced under vision-backfill; each row under vision.
    const runTraces = await listTraces({ feature: "vision-backfill" });
    expect(runTraces.traces).toHaveLength(1);
    expect(runTraces.traces[0].status).toBe("success");
    const describeTraces = await listTraces({ feature: "vision" });
    expect(describeTraces.traces).toHaveLength(3);
  });

  it("is idempotent — a second run finds nothing pending", async () => {
    await seedPending(10);
    await runVisionBackfill({ complete: async () => fakeComplete("x") }, source(), {}, ctx.db);

    const second = await runVisionBackfill(
      { complete: async () => fakeComplete("y") },
      source(),
      {},
      ctx.db,
    );
    expect(second.described).toBe(0);
    expect(second.summary).toBe("nothing pending");
  });

  it("leaves a row pending and counts it unresolved when the description is empty", async () => {
    await seedPending(10);
    const result = await runVisionBackfill(
      { complete: async () => fakeComplete("   ") }, // empty after trim → describeAndStore skips
      source(),
      {},
      ctx.db,
    );
    expect(result.described).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(await countPendingMedia(ctx.db, "tg")).toBe(1);
  });

  it("stops early when aborted, leaving the rest pending", async () => {
    await seedPending(10);
    await seedPending(11);
    await seedPending(12);

    // Abort after the first described row.
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      return fakeComplete("desc");
    });
    const result = await runVisionBackfill(
      { complete },
      source(),
      { isAborted: () => calls >= 1 },
      ctx.db,
    );

    expect(result.interrupted).toBe(true);
    expect(result.described).toBe(1);
    expect(await countPendingMedia(ctx.db, "tg")).toBe(2);
  });

  it("leaves media alone while its message is still held by the live pipeline", async () => {
    await seedPending(10, "5", { processed: false }); // live reply still in flight
    await seedPending(11); // released — a genuine leftover

    // The scan itself excludes the held row…
    expect((await listPendingMedia(ctx.db, "tg")).map((r) => r.sourceMessageId)).toEqual(["11"]);

    // …so a run describes only the leftover and never races the live pass.
    const result = await runVisionBackfill(
      { complete: async () => fakeComplete("a photo") },
      source(),
      {},
      ctx.db,
    );
    expect(result.described).toBe(1);
    expect(await countPendingMedia(ctx.db, "tg")).toBe(1);
  });

  it("reclaims a held row once the hold times out (crashed pipeline)", async () => {
    const row = await seedPending(10, "5", { processed: false });
    // Backdate the media past the hold timeout — a pipeline that died before
    // its `finally` released the hold must not hide the row forever.
    await ctx.db
      .update(sourceMedia)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(sourceMedia.id, row!.id));

    expect(await listPendingMedia(ctx.db, "tg")).toHaveLength(1);
  });

  it("skips (does not run) when the advisory lock is already held", async () => {
    await seedPending(10);

    // Hold the lock across a concurrent run.
    const inner = await withAdvisoryLock(
      "vision-backfill",
      async () => {
        return runVisionBackfill({ complete: async () => fakeComplete("z") }, source(), {}, ctx.db);
      },
      ctx.db,
    );

    expect(inner.ran).toBe(true);
    if (inner.ran) {
      expect(inner.result.summary).toBe("skipped — another run holds the lock");
      expect(inner.result.described).toBe(0);
    }
    // The row was never touched — still pending for the next run.
    expect(await listPendingMedia(ctx.db, "tg")).toHaveLength(1);
  });
});

describe("withAdvisoryLock", () => {
  it("runs fn and releases so a later call can re-acquire", async () => {
    const first = await withAdvisoryLock("k", async () => 1, ctx.db);
    expect(first).toEqual({ ran: true, result: 1 });
    const second = await withAdvisoryLock("k", async () => 2, ctx.db);
    expect(second).toEqual({ ran: true, result: 2 });
  });

  it("does not run fn when the lock is already held", async () => {
    const outerRan = await withAdvisoryLock(
      "k",
      async () => {
        const fn = vi.fn(async () => 99);
        const nested = await withAdvisoryLock("k", fn, ctx.db);
        expect(nested.ran).toBe(false);
        expect(fn).not.toHaveBeenCalled();
        return true;
      },
      ctx.db,
    );
    expect(outerRan.ran).toBe(true);
  });
});
