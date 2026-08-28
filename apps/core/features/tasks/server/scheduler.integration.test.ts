import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as storeSchema from "../../../store/schema";
import { tryGetToolContext } from "@/server/mcp/context";
import { closePool } from "@/db/pool";
import type { StoreDb } from "@/server/store/db";

import { MAX_ONE_SHOT_ATTEMPTS } from "../types";
import { getTaskById } from "./repository";
import { manualFireTask, runDueTasks, type DueRunDeps } from "./scheduler";
import { createTaskService, getTask } from "./service";

/**
 * The due-run loop against a real database, with a capturing delivery sink and
 * deterministic generator standing in for the LLM and the bot. What matters
 * here is the settle logic per trigger kind — an interval advances, a spent
 * one-shot is deleted, a failed one-shot retries and finally disables — and
 * that a fire's deliveries come only from the `deliver` binding.
 */

const V1_MIGRATIONS = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;
const ctx = { get db() { return db; } };

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("tasks_scheduler_store");
  // Settings (timezone) still read the v1 database through the app pool.
  const v1Url = await pg.createDatabase("tasks_scheduler_v1");
  await applyMigrations(url, STORE_MIGRATIONS);
  await applyMigrations(v1Url, V1_MIGRATIONS);
  process.env.DATABASE_URL = v1Url;
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema: storeSchema }) as StoreDb;
});

afterAll(async () => {
  await pool?.end();
  await closePool();
  await pg?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistants RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO assistants (id, name, persona) VALUES ('assistant-1', 'Fixture Assistant', '')`,
  );
});

const trigger = { kind: "dashboard" } as const;
const CHAT = "-1001";
const ASSISTANT = "assistant-1";

/**
 * A `complete` that behaves like the model calling the source app's
 * `send_message` tool once per text: since Phase 5 the sending is the source's
 * and what reaches the fire is the delivery report.
 */
function sendingComplete(texts: string[], deliveries?: { texts: string[] }) {
  return vi.fn().mockImplementation(async () => {
    const toolCtx = tryGetToolContext();
    for (const [index, text] of texts.entries()) {
      deliveries?.texts.push(text);
      await toolCtx!.onDelivered!({ ok: true, messageId: 100 + index, text });
    }
    return { content: "done", model: "m", latencyMs: 1 };
  });
}

function deps(over: Partial<DueRunDeps> = {}): DueRunDeps {
  return {
    timezone: "UTC",
    personaFor: async () => null,
    complete: sendingComplete(["fired!"]),
    db: ctx.db,
    ...over,
  };
}

/** Create a timed task and force it due by aiming the clock past its instant. */
async function dueTask(over: Record<string, unknown> = {}) {
  const task = await createTaskService(
    {
      assistantId: ASSISTANT,
      chatId: CHAT,
      instruction: "Check in.",
      triggerKind: "interval",
      everyMinutes: 10,
      targetUserIds: [],
      enabled: true,
      ...over,
    } as Parameters<typeof createTaskService>[0],
    trigger,
    ctx.db,
  );
  return task;
}

/** A `now` far enough ahead that any freshly-created task is due. */
function later(task: { nextRunAt: string | null }): Date {
  return new Date(Date.parse(task.nextRunAt!) + 1000);
}

describe("runDueTasks", () => {
  it("fires a due interval task, records what was delivered, and advances the schedule", async () => {
    const task = await dueTask();
    const delivered = { texts: [] as string[] };
    const now = later(task);

    const result = await runDueTasks(deps({ complete: sendingComplete(["fired!"], delivered), now }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(delivered.texts).toEqual(["fired!"]);
    const settled = await getTask(task.id, ctx.db);
    // Advanced from the settle instant, and the delivery recorded for variation.
    expect(Date.parse(settled!.nextRunAt!)).toBe(now.getTime() + 10 * 60_000);
    expect(settled!.recentDeliveries).toEqual(["fired!"]);
    expect(settled!.lastRunAt).not.toBeNull();
  });

  it("counts a quiet fire as fired and advances without touching recent deliveries", async () => {
    const task = await dueTask();
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "nothing to report", model: "m", latencyMs: 1 });

    const result = await runDueTasks(deps({ complete, now: later(task) }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    const settled = await getTask(task.id, ctx.db);
    expect(settled!.nextRunAt).not.toBeNull();
    expect(settled!.recentDeliveries).toEqual([]);
  });

  it("deletes a timeout task once it has fired — a spent one-shot", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });

    const result = await runDueTasks(deps({ now: later(task) }));

    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(await getTaskById(ctx.db, task.id)).toBeNull();
  });

  it("keeps a failed one-shot due for retries, then disables it at the cap", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });
    const failing = deps({
      complete: vi.fn().mockRejectedValue(new Error("provider down")),
      now: later(task),
    });

    for (let i = 1; i < MAX_ONE_SHOT_ATTEMPTS; i++) {
      expect(await runDueTasks(failing)).toEqual({ fired: 0, failed: 1 });
      const row = await getTask(task.id, ctx.db);
      expect(row).toMatchObject({ enabled: true, attempts: i });
      expect(row!.nextRunAt).not.toBeNull();
    }
    // The last allowed attempt disables the task — kept, never deleted, so the
    // dashboard can show why it stopped (user decision, 2026-07-20).
    expect(await runDueTasks(failing)).toEqual({ fired: 0, failed: 1 });
    expect(await getTask(task.id, ctx.db)).toMatchObject({
      enabled: false,
      attempts: MAX_ONE_SHOT_ATTEMPTS,
    });
  });

  it("fires nothing when nothing is due", async () => {
    await dueTask();
    const delivered = { texts: [] as string[] };

    const result = await runDueTasks(
      deps({
        complete: sendingComplete(["fired!"], delivered),
        now: new Date(Date.now() - 60_000),
      }),
    );

    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(delivered.texts).toEqual([]);
  });
});

describe("manualFireTask", () => {
  /** The injectable collaborators, standing in for the live LLM + bot. */
  function live(
    over: Partial<Pick<DueRunDeps, "personaFor" | "complete">> = {},
    delivered?: { texts: string[] },
  ) {
    return {
      personaFor: async () => null,
      complete: sendingComplete(["manual!"], delivered),
      ...over,
    };
  }

  it("fires without consuming the schedule — a one-shot survives untouched", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });
    const delivered = { texts: [] as string[] };

    const result = await manualFireTask(task.id, trigger, ctx.db, live({}, delivered));

    expect(result).toEqual({ ok: true, sent: ["manual!"] });
    expect(delivered.texts).toEqual(["manual!"]);
    // The row is exactly as it was: not deleted (a regular fire would have
    // spent this one-shot), schedule and counters untouched.
    const after = await getTaskById(ctx.db, task.id);
    expect(after).toMatchObject({
      nextRunAt: task.nextRunAt,
      attempts: 0,
      lastRunAt: null,
      recentDeliveries: [],
      enabled: true,
    });
  });

  it("leaves the row untouched even when the manual fire fails", async () => {
    const task = await dueTask({ triggerKind: "timeout", delayMinutes: 5, everyMinutes: null });

    const result = await manualFireTask(
      task.id,
      trigger,
      ctx.db,
      live({ complete: vi.fn().mockRejectedValue(new Error("provider down")) }),
    );

    // A failed manual run is reported, but never counts toward the one-shot's
    // retry budget — that budget belongs to the schedule.
    expect(result.ok).toBe(false);
    expect(await getTaskById(ctx.db, task.id)).toMatchObject({ attempts: 0, enabled: true });
  });

  it("refuses a prompt-kind task — there is no fire to run", async () => {
    const rule = await createTaskService(
      {
        assistantId: ASSISTANT,
        chatId: CHAT,
        instruction: "Answer briefly.",
        triggerKind: "on-reply",
        targetUserIds: [],
        enabled: true,
      } as Parameters<typeof createTaskService>[0],
      trigger,
      ctx.db,
    );

    await expect(manualFireTask(rule.id, trigger, ctx.db, live())).rejects.toThrow(
      /timed task/i,
    );
  });

  it("rejects an unknown id", async () => {
    await expect(manualFireTask("nope", trigger, ctx.db, live())).rejects.toThrow(
      /unknown task/i,
    );
  });
});
