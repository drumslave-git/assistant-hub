import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import {
  getRecentDeliveries,
  listDueScheduledTasks,
  markScheduledTaskRun,
  nextRecentDeliveries,
} from "./repository";
import { getTaskSchedulerInfo } from "./scheduler";
import {
  createScheduledTaskService,
  editScheduledTaskService,
  findTasks,
  getScheduledTasks,
  removeScheduledTaskService,
} from "./service";

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

const trigger = { kind: "dashboard" } as const;

const base = {
  chatId: "555",
  instruction: "call mom",
  scheduleKind: "daily" as const,
  timeOfDay: "09:00",
};

describe("createScheduledTaskService", () => {
  it("creates a daily task with a computed next run and records a trace", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    expect(task.id).toBeTruthy();
    expect(task).toMatchObject({
      chatId: "555",
      instruction: "call mom",
      scheduleKind: "daily",
      timeOfDay: "09:00",
      enabled: true,
    });
    expect(task.nextRunAt).not.toBeNull();
    // Next run is at 09:00 UTC (today or tomorrow) — the minutes/seconds land on :00.
    expect(new Date(task.nextRunAt!).getUTCMinutes()).toBe(0);
    expect(new Date(task.nextRunAt!).getUTCHours()).toBe(9);

    const traces = await listTraces({ feature: "scheduled-tasks" });
    expect(traces.traces[0]).toMatchObject({ action: "create", status: "success" });

    const all = await getScheduledTasks("555", ctx.db);
    expect(all).toHaveLength(1);
  });

  it("interprets the schedule in the configured operator timezone", async () => {
    await upsertSettings(ctx.db, { timezone: "Asia/Tokyo" });
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    // 09:00 in Tokyo (UTC+9) is 00:00Z — the next-run instant is stored in UTC.
    expect(new Date(task.nextRunAt!).getUTCHours()).toBe(0);
  });

  it("persists the gathered context, storing blank as null", async () => {
    const withContext = await createScheduledTaskService(
      { ...base, context: "  Mom asked about the visit on Sunday.  " },
      trigger,
      ctx.db,
    );
    expect(withContext.context).toBe("Mom asked about the visit on Sunday.");

    const without = await createScheduledTaskService({ ...base, context: "   " }, trigger, ctx.db);
    expect(without.context).toBeNull();
  });

  it("records the author (createdByUserId) on the task", async () => {
    const task = await createScheduledTaskService(
      { ...base, createdByUserId: "100" },
      trigger,
      ctx.db,
    );
    expect(task.createdByUserId).toBe("100");
  });

  it("rejects a weekly task with no weekdays and a past one-shot", async () => {
    await expect(
      createScheduledTaskService(
        { ...base, scheduleKind: "weekly", weekdays: [] },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/weekday/i);
    await expect(
      createScheduledTaskService(
        { ...base, scheduleKind: "once", timeOfDay: "09:00", runDate: "2000-01-01" },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/past/i);
  });
});

describe("editScheduledTaskService", () => {
  it("recomputes the next run and disabling clears it", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    const disabled = await editScheduledTaskService(task.id, { enabled: false }, trigger, ctx.db);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    const reenabled = await editScheduledTaskService(
      task.id,
      { enabled: true, timeOfDay: "10:30" },
      trigger,
      ctx.db,
    );
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.timeOfDay).toBe("10:30");
    expect(new Date(reenabled.nextRunAt!).getUTCHours()).toBe(10);
  });

  it("replaces, keeps, and clears the saved context", async () => {
    const task = await createScheduledTaskService(
      { ...base, context: "original background" },
      trigger,
      ctx.db,
    );
    const replaced = await editScheduledTaskService(
      task.id,
      { context: "newer background" },
      trigger,
      ctx.db,
    );
    expect(replaced.context).toBe("newer background");

    const untouched = await editScheduledTaskService(task.id, { timeOfDay: "10:00" }, trigger, ctx.db);
    expect(untouched.context).toBe("newer background");

    const cleared = await editScheduledTaskService(task.id, { context: null }, trigger, ctx.db);
    expect(cleared.context).toBeNull();
  });

  it("rejects an unknown id", async () => {
    await expect(
      editScheduledTaskService("nope", { enabled: false }, trigger, ctx.db),
    ).rejects.toThrow(/unknown task/i);
  });
});

describe("removeScheduledTaskService", () => {
  it("deletes and traces", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    await removeScheduledTaskService(task.id, trigger, ctx.db);
    expect(await getScheduledTasks("555", ctx.db)).toHaveLength(0);
    await expect(removeScheduledTaskService(task.id, trigger, ctx.db)).rejects.toThrow(/unknown/i);
  });
});

describe("findTasks", () => {
  it("substring-matches instructions within a chat", async () => {
    await createScheduledTaskService({ ...base, instruction: "call mom" }, trigger, ctx.db);
    await createScheduledTaskService({ ...base, instruction: "water plants" }, trigger, ctx.db);
    await createScheduledTaskService(
      { ...base, chatId: "777", instruction: "call mom" },
      trigger,
      ctx.db,
    );
    const inChat = await findTasks("call", "555", ctx.db);
    expect(inChat).toHaveLength(1);
    const everywhere = await findTasks("call", undefined, ctx.db);
    expect(everywhere).toHaveLength(2);
  });
});

describe("due scan + markScheduledTaskRun", () => {
  it("lists only enabled due tasks and advancing updates run state + capped deliveries", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    // Not due yet (next run is in the future).
    expect(await listDueScheduledTasks(ctx.db, new Date())).toHaveLength(0);
    // Due when we ask from far in the future.
    const future = new Date(Date.now() + 3 * 86_400_000);
    const due = await listDueScheduledTasks(ctx.db, future);
    expect(due.map((t) => t.id)).toContain(task.id);

    // Advance with a delivery; recentDeliveries keeps newest-first, capped at 5.
    let recent = await getRecentDeliveries(ctx.db, task.id);
    for (let i = 1; i <= 6; i += 1) {
      recent = nextRecentDeliveries(recent, `msg ${i}`);
      await markScheduledTaskRun(ctx.db, task.id, {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + 86_400_000),
        recentDeliveries: recent,
      });
    }
    const stored = await getRecentDeliveries(ctx.db, task.id);
    expect(stored).toEqual(["msg 6", "msg 5", "msg 4", "msg 3", "msg 2"]);

    // Advancing leaves the task enabled and armed — a task with no future run is
    // deleted by the scheduler instead, so it never reaches this call.
    const after = await getScheduledTasks("555", ctx.db);
    expect(after[0]).toMatchObject({ enabled: true });
    expect(after[0].nextRunAt).not.toBeNull();
  });
});

describe("getTaskSchedulerInfo", () => {
  /** Push a task's run instant into the past, leaving it enabled and unfired. */
  const makeOverdue = (id: string) =>
    markScheduledTaskRun(ctx.db, id, {
      lastRunAt: new Date(Date.now() - 2 * 86_400_000),
      nextRunAt: new Date(Date.now() - 86_400_000),
    });

  it("reports the next upcoming run, nothing overdue, and no pause by default", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    const info = await getTaskSchedulerInfo(ctx.db);
    expect(info).toMatchObject({ paused: false, overdue: 0 });
    expect(info.nextRunAt).toBe(task.nextRunAt);
  });

  it("counts a task whose run instant has passed as overdue, and leaves it out of the next run", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    await makeOverdue(task.id);

    const info = await getTaskSchedulerInfo(ctx.db);
    expect(info.overdue).toBe(1);
    // The only task's run is in the past, so there is no *upcoming* run to show.
    expect(info.nextRunAt).toBeNull();
  });

  it("reports paused while maintenance mode is on — the reason a due task never fires", async () => {
    const task = await createScheduledTaskService(base, trigger, ctx.db);
    await makeOverdue(task.id);
    await upsertSettings(ctx.db, { maintenanceModeEnabled: true });

    const info = await getTaskSchedulerInfo(ctx.db);
    // The task is still due (it is skipped, not advanced) and the dashboard can
    // now say why it has not been delivered.
    expect(info).toMatchObject({ paused: true, overdue: 1 });
  });
});
