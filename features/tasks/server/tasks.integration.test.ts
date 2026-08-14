import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  recordGroupMembership,
  upsertKnownGroup,
} from "@/features/known-groups/server/repository";
import { upsertKnownUser } from "@/features/known-users/server/repository";
import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { MAX_PROMPT_TASKS_PER_SCOPE } from "./schema";
import {
  createTaskFromChat,
  createTaskService,
  deleteTaskFromChat,
  editTaskService,
  getActiveTasksForChat,
  getTasksForChat,
  getTasksView,
  removeTaskService,
  updateTaskFromChat,
} from "./service";

/**
 * Tasks against a real database: scope resolution (a chat sees its own tasks
 * plus the global ones), the prompt-kind cap and duplicate guard, sender
 * targeting, per-kind timing, and the two chat-side permission gates — the
 * rules gate for standing kinds, the creator-or-owner gate for timed ones.
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

const trigger = { kind: "dashboard" } as const;
const chatTrigger = { kind: "telegram", actor: "100", correlationId: "100" } as const;

/** A group chat id (negative) and DM ids (positive, equal to the user id). */
const GROUP = "-1001";
const DM_USER = "100";
const OTHER_USER = "200";

function create(over: Record<string, unknown> = {}) {
  return createTaskService(
    {
      chatId: GROUP,
      instruction: "Answer briefly.",
      triggerKind: "on-reply",
      targetUserIds: [],
      enabled: true,
      ...over,
    } as Parameters<typeof createTaskService>[0],
    trigger,
    ctx.db,
  );
}

/** Put people on a group's roster (a task can only name people seen there). */
async function joinGroup(chatId: string, ...userIds: string[]) {
  await upsertKnownGroup(ctx.db, { chatId, title: "Test group", type: "supergroup" });
  for (const userId of userIds) {
    await upsertKnownUser(ctx.db, {
      userId,
      username: null,
      firstName: `User ${userId}`,
      lastName: null,
    });
    await recordGroupMembership(ctx.db, chatId, userId);
  }
}

describe("scopes and selection", () => {
  it("gives a chat its own tasks plus the global ones, and nobody else's", async () => {
    const own = await create({ chatId: GROUP, instruction: "Answer briefly." });
    const global = await create({ chatId: null, instruction: "Never swear." });
    await create({ chatId: "-2002", instruction: "Somebody else's task." });

    const tasks = await getTasksForChat(GROUP, ctx.db);

    expect(tasks.map((t) => t.id).sort()).toEqual([own.id, global.id].sort());
  });

  it("separates the prompt set from the `message` set, dropping disabled and timed tasks", async () => {
    await create({ instruction: "Answer briefly." });
    await create({ instruction: "Download video links.", triggerKind: "message" });
    await create({ instruction: "Paused.", enabled: false });
    await create({
      instruction: "Hourly check.",
      triggerKind: "interval",
      everyMinutes: 60,
    });

    const { prompt, message } = await getActiveTasksForChat(GROUP, DM_USER, ctx.db);

    expect(prompt.map((t) => t.instruction)).toEqual([
      "Answer briefly.",
      "Download video links.",
    ]);
    expect(message.map((t) => t.instruction)).toEqual(["Download video links."]);
  });

  it("hands a targeted task only to the people it names, and to no sender at all on a fire", async () => {
    await joinGroup(GROUP, "11", "22");
    await create({ instruction: "Everyone's task." });
    await create({ instruction: "Alice's task.", targetUserIds: ["11"] });

    expect((await getActiveTasksForChat(GROUP, "11", ctx.db)).prompt.map((t) => t.instruction)).toEqual(
      ["Everyone's task.", "Alice's task."],
    );
    expect((await getActiveTasksForChat(GROUP, "22", ctx.db)).prompt.map((t) => t.instruction)).toEqual(
      ["Everyone's task."],
    );
    expect((await getActiveTasksForChat(GROUP, null, ctx.db)).prompt.map((t) => t.instruction)).toEqual(
      ["Everyone's task."],
    );
  });
});

describe("dashboard CRUD", () => {
  it("creates, edits and deletes, recording a trace for each", async () => {
    const task = await create();
    await editTaskService(task.id, { instruction: "Answer very briefly." }, trigger, ctx.db);
    await removeTaskService(task.id, trigger, ctx.db);

    expect(await getTasksView(ctx.db)).toEqual([]);
    const { traces } = await listTraces({ feature: "tasks" });
    expect(traces.map((t) => t.action).sort()).toEqual(["create", "delete", "update"]);
    expect(traces.every((t) => t.status === "success")).toBe(true);
  });

  it("refuses a duplicate standing task in the same scope, but allows it in another", async () => {
    await create({ instruction: "Answer briefly." });
    await expect(create({ instruction: "answer BRIEFLY." })).rejects.toMatchObject({ status: 409 });
    await expect(create({ chatId: null, instruction: "Answer briefly." })).resolves.toBeTruthy();
  });

  it("caps standing tasks per scope, leaving timed tasks uncapped and un-deduplicated", async () => {
    for (let i = 0; i < MAX_PROMPT_TASKS_PER_SCOPE; i++) {
      await create({ instruction: `Rule ${i}.` });
    }
    await expect(create({ instruction: "One too many." })).rejects.toMatchObject({ status: 409 });
    // Timed tasks are not part of the prompt budget: same text twice is two
    // reminders, and the cap does not apply.
    const timed = { triggerKind: "interval", everyMinutes: 60 };
    await expect(create({ instruction: "Check the feed.", ...timed })).resolves.toBeTruthy();
    await expect(create({ instruction: "Check the feed.", ...timed })).resolves.toBeTruthy();
  });

  it("computes each timed kind's next run at creation", async () => {
    const before = Date.now();
    const interval = await create({
      instruction: "Every ten minutes.",
      triggerKind: "interval",
      everyMinutes: 10,
    });
    const timeout = await create({
      instruction: "In an hour.",
      triggerKind: "timeout",
      delayMinutes: 60,
    });
    const daily = await create({
      instruction: "Every day.",
      triggerKind: "schedule",
      timeOfDay: "09:00",
    });

    expect(Date.parse(interval.nextRunAt!)).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
    expect(Date.parse(timeout.nextRunAt!)).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(daily.nextRunAt).not.toBeNull();
    // Prompt kinds never carry a run instant.
    expect((await create({ instruction: "A rule." })).nextRunAt).toBeNull();
  });

  it("refuses a timed task in the global scope, and a one-time run in the past", async () => {
    await expect(
      create({ chatId: null, instruction: "Hourly.", triggerKind: "interval", everyMinutes: 60 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create({
        instruction: "Yesterday.",
        triggerKind: "schedule",
        timeOfDay: "09:00",
        runDate: "2020-01-01",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to name someone off the roster, or anyone outside a group standing task", async () => {
    await joinGroup(GROUP, "11");
    await expect(create({ targetUserIds: ["22"] })).rejects.toMatchObject({ status: 400 });
    await expect(create({ chatId: DM_USER, targetUserIds: [DM_USER] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      create({
        instruction: "Hourly.",
        triggerKind: "interval",
        everyMinutes: 60,
        targetUserIds: ["11"],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edits the trigger across kinds, recomputing timing and resetting attempts", async () => {
    await joinGroup(GROUP, "11");
    const task = await create({ instruction: "Was a rule.", targetUserIds: ["11"] });

    const timed = await editTaskService(
      task.id,
      { triggerKind: "interval", everyMinutes: 30 },
      trigger,
      ctx.db,
    );

    expect(timed.triggerKind).toBe("interval");
    expect(timed.nextRunAt).not.toBeNull();
    // Crossing to a timed kind drops the audience — targeting is a prompt fact.
    expect(timed.targetUserIds).toEqual([]);
    expect(timed.attempts).toBe(0);
  });
});

describe("chat-side gate — standing kinds (the rules gate)", () => {
  it("lets a user set a standing task in their own DM, and is idempotent on repeat", async () => {
    const first = await createTaskFromChat(
      { chatId: DM_USER, userId: DM_USER, instruction: "Answer briefly.", triggerKind: "on-reply" },
      chatTrigger,
      ctx.db,
    );
    const again = await createTaskFromChat(
      {
        chatId: DM_USER,
        userId: DM_USER,
        instruction: "  answer BRIEFLY.  ",
        triggerKind: "message",
      },
      chatTrigger,
      ctx.db,
    );

    expect(first.status).toBe("created");
    // The stored task is returned untouched — a repeat never silently rewrites it.
    expect(again).toMatchObject({
      status: "exists",
      task: { triggerKind: "on-reply", instruction: "Answer briefly." },
    });
    expect(await getTasksForChat(DM_USER, ctx.db)).toHaveLength(1);
  });

  it("amends the audience when the same standing task is set again for other people", async () => {
    await joinGroup(GROUP, "11", "22");
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const first = await createTaskFromChat(
      {
        chatId: GROUP,
        userId: DM_USER,
        instruction: "Answer briefly.",
        triggerKind: "on-reply",
        targetUserIds: ["11"],
      },
      chatTrigger,
      ctx.db,
    );
    const widened = await createTaskFromChat(
      {
        chatId: GROUP,
        userId: DM_USER,
        instruction: "Answer briefly.",
        triggerKind: "on-reply",
        targetUserIds: ["22", "11"],
      },
      chatTrigger,
      ctx.db,
    );

    expect(first.status).toBe("created");
    expect(widened).toMatchObject({ status: "updated", task: { targetUserIds: ["22", "11"] } });
    expect(await getTasksForChat(GROUP, ctx.db)).toHaveLength(1);
  });

  it("refuses a non-owner writing a standing task in a group, before the duplicate check", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    await createTaskFromChat(
      { chatId: GROUP, userId: DM_USER, instruction: "Answer briefly.", triggerKind: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    // An outsider must not learn what a chat's rules are by watching "created"
    // turn into "exists".
    const denied = await createTaskFromChat(
      { chatId: GROUP, userId: OTHER_USER, instruction: "Answer briefly.", triggerKind: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(denied).toMatchObject({ status: "denied" });
  });

  it("shows a global task to the chat but refuses to change it from there", async () => {
    const global = await create({ chatId: null, instruction: "Never swear." });
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });

    expect((await getTasksForChat(GROUP, ctx.db)).map((t) => t.id)).toContain(global.id);
    const result = await deleteTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id: global.id },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(result).toMatchObject({ reason: expect.stringMatching(/every chat/i) });
    expect((await getTasksView(ctx.db)).map((t) => t.id)).toContain(global.id);
  });

  it("cannot see or touch another chat's task", async () => {
    const other = await create({ chatId: "-2002", instruction: "Somebody else's task." });
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });

    const updated = await updateTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id: other.id, patch: { instruction: "mine now" } },
      chatTrigger,
      ctx.db,
    );
    const deleted = await deleteTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id: other.id },
      chatTrigger,
      ctx.db,
    );

    expect(updated).toEqual({ status: "not_found" });
    expect(deleted).toEqual({ status: "not_found" });
  });
});

describe("chat-side gate — timed kinds (creator or owner)", () => {
  const timedInput = (userId: string) => ({
    chatId: GROUP,
    userId,
    instruction: "Remind us to stretch.",
    triggerKind: "timeout" as const,
    delayMinutes: 30,
  });

  it("lets anyone in the chat create a timed task", async () => {
    const result = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.task).toMatchObject({ source: "chat", createdByUserId: OTHER_USER });
      expect(result.task.nextRunAt).not.toBeNull();
    }
  });

  it("lets only the creator or the owner change or cancel it", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const created = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    const id = created.status === "created" ? created.task.id : "";

    const stranger = await updateTaskFromChat(
      { chatId: GROUP, userId: "300", id, patch: { enabled: false } },
      chatTrigger,
      ctx.db,
    );
    const creator = await updateTaskFromChat(
      { chatId: GROUP, userId: OTHER_USER, id, patch: { enabled: false } },
      chatTrigger,
      ctx.db,
    );
    const owner = await deleteTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id },
      chatTrigger,
      ctx.db,
    );

    expect(stranger).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/created by someone else/i),
    });
    expect(creator).toMatchObject({ status: "updated" });
    expect(owner).toMatchObject({ status: "deleted" });
  });

  it("honours a matched standing task's lent authority for the owner exemption", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const created = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    const id = created.status === "created" ? created.task.id : "";

    const viaAuthority = await deleteTaskFromChat(
      { chatId: GROUP, userId: "300", authorityUserId: DM_USER, id },
      chatTrigger,
      ctx.db,
    );

    expect(viaAuthority).toMatchObject({ status: "deleted" });
  });
});
