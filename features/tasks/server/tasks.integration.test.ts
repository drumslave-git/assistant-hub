import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  recordGroupMembership,
  upsertKnownGroup,
} from "@/features/known-groups/server/repository";
import { upsertKnownUser } from "@/features/known-users/server/repository";
import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { insertTask } from "./repository";
import { MAX_PROMPT_TASKS_PER_SCOPE, type UpdateTaskInput } from "./schema";
import {
  createTaskFromChat,
  createTaskService,
  deleteTaskFromChat,
  editTaskService,
  getActiveTasksForChat,
  getChatVisibleTask,
  getChatVisibleTasks,
  getTasksView,
  removeTaskService,
  updateTaskFromChat,
} from "./service";

/**
 * Tasks against a real database: scope resolution (a chat sees its own tasks
 * plus the global ones), the prompt-kind cap and duplicate guard, sender
 * targeting, per-kind timing, the two chat-side permission gates — the rules
 * gate for standing kinds, the creator-or-owner gate for timed ones — and the
 * paused-task rules (invisible from chat; pausing is dashboard-only).
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

    const tasks = await getChatVisibleTasks(GROUP, ctx.db);

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

/**
 * A paused task belongs to the operator alone (user decision, 2026-08-14). The
 * bot never sees one, so it can never hold a rule it can neither carry out nor
 * remove — and it cannot pause anything itself: from a chat, cancelling is
 * deleting.
 */
describe("paused tasks", () => {
  it("leaves paused tasks out of what a chat can see, its own and the global ones", async () => {
    const live = await create({ instruction: "Answer briefly." });
    await create({ instruction: "Paused rule.", enabled: false });
    await create({ chatId: null, instruction: "Paused everywhere.", enabled: false });
    const globalLive = await create({ chatId: null, instruction: "Never swear." });

    expect((await getChatVisibleTasks(GROUP, ctx.db)).map((t) => t.id).sort()).toEqual(
      [live.id, globalLive.id].sort(),
    );
  });

  it("reads a paused task as an unknown id, and refuses to change or delete it", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const paused = await create({ instruction: "Paused rule.", enabled: false });

    const read = await getChatVisibleTask(paused.id, GROUP, ctx.db);
    const updated = await updateTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id: paused.id, patch: { instruction: "Reworded." } },
      chatTrigger,
      ctx.db,
    );
    const deleted = await deleteTaskFromChat(
      { chatId: GROUP, userId: DM_USER, id: paused.id },
      chatTrigger,
      ctx.db,
    );

    expect(read).toBeNull();
    expect(updated).toEqual({ status: "not_found" });
    expect(deleted).toEqual({ status: "not_found" });
    // Invisible, not gone: the operator still has it in the dashboard.
    expect((await getTasksView(ctx.db)).map((t) => t.id)).toEqual([paused.id]);
  });

  it("refuses a chat-side patch that would pause a task, and leaves it running", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const task = await create({ instruction: "Answer briefly." });

    const result = await updateTaskFromChat(
      {
        chatId: GROUP,
        userId: DM_USER,
        id: task.id,
        // The tool schema cannot express this; every other caller of the
        // service gets an honest refusal rather than a silent drop.
        patch: { enabled: false } as Omit<UpdateTaskInput, "enabled">,
      },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/cannot be paused/i),
    });
    expect(await getChatVisibleTask(task.id, GROUP, ctx.db)).toMatchObject({ enabled: true });
  });

  it("creates a fresh standing task rather than claiming a paused twin is in force", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    await create({ instruction: "Answer briefly.", enabled: false });

    const result = await createTaskFromChat(
      { chatId: GROUP, userId: DM_USER, instruction: "Answer briefly.", triggerKind: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(result.status).toBe("created");
    expect((await getChatVisibleTasks(GROUP, ctx.db)).map((t) => t.instruction)).toEqual([
      "Answer briefly.",
    ]);
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

  it("lets a paused task's wording be used again — the duplicate guard is a prompt budget", async () => {
    await create({ instruction: "Answer briefly.", enabled: false });
    await expect(create({ instruction: "answer BRIEFLY." })).resolves.toBeTruthy();
  });

  it("caps standing tasks per scope, leaving timed tasks uncapped", async () => {
    for (let i = 0; i < MAX_PROMPT_TASKS_PER_SCOPE; i++) {
      await create({ instruction: `Rule ${i}.` });
    }
    await expect(create({ instruction: "One too many." })).rejects.toMatchObject({ status: 409 });
    // Timed tasks are not part of the prompt budget — they cost nothing until
    // they fire, so the cap does not apply to them.
    const timed = { triggerKind: "interval", everyMinutes: 60 };
    for (let i = 0; i < MAX_PROMPT_TASKS_PER_SCOPE + 1; i++) {
      await expect(create({ instruction: `Check feed ${i}.`, ...timed })).resolves.toBeTruthy();
    }
  });

  /**
   * Same wording *and* the same timing is one job asked for twice (user
   * decision, 2026-08-14, after trace `796852a6…` left two identical reminders
   * three seconds apart). Same wording at a different time is two jobs.
   */
  it("refuses a timed task identical to one in force, and allows a differently timed one", async () => {
    const daily = { triggerKind: "schedule", timeOfDay: "09:00" };
    await create({ instruction: "Post the standup prompt.", ...daily });

    await expect(create({ instruction: "post the STANDUP prompt.", ...daily })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      create({ instruction: "Post the standup prompt.", triggerKind: "schedule", timeOfDay: "18:00" }),
    ).resolves.toBeTruthy();
    await expect(
      create({ instruction: "Post the standup prompt.", triggerKind: "interval", everyMinutes: 60 }),
    ).resolves.toBeTruthy();
  });

  it("recognizes the same clock time however it was written", async () => {
    await create({ instruction: "Water the plants.", triggerKind: "schedule", timeOfDay: "09:00" });
    await expect(
      create({ instruction: "Water the plants.", triggerKind: "schedule", timeOfDay: "9:00" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an edit that would retime a task onto one already in force", async () => {
    await create({ instruction: "Ping us.", triggerKind: "interval", everyMinutes: 30 });
    const second = await create({ instruction: "Ping us.", triggerKind: "interval", everyMinutes: 45 });

    await expect(
      editTaskService(second.id, { everyMinutes: 30 }, trigger, ctx.db),
    ).rejects.toMatchObject({ status: 409 });
    // Its own row never counts against it: an edit that changes something else
    // still goes through.
    await expect(
      editTaskService(second.id, { instruction: "Ping us twice." }, trigger, ctx.db),
    ).resolves.toBeTruthy();
  });

  it("still lets an operator pause one of a pair that predates the rule", async () => {
    const task = await create({ instruction: "Ping us.", triggerKind: "interval", everyMinutes: 30 });
    // A second identical row, as one stored before duplicates were refused —
    // pausing must stay the way out of that, not be blocked by it.
    await insertTask(ctx.db, randomUUID(), {
      chatId: GROUP,
      threadId: null,
      createdByUserId: null,
      source: "dashboard",
      instruction: "Ping us.",
      context: null,
      triggerKind: "interval",
      targetUserIds: [],
      everyMinutes: 30,
      delayMinutes: null,
      timeOfDay: null,
      weekdays: null,
      runDate: null,
      enabled: true,
      nextRunAt: new Date(),
    });

    await expect(
      editTaskService(task.id, { enabled: false }, trigger, ctx.db),
    ).resolves.toMatchObject({ enabled: false });
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
    expect(await getChatVisibleTasks(DM_USER, ctx.db)).toHaveLength(1);
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
    expect(await getChatVisibleTasks(GROUP, ctx.db)).toHaveLength(1);
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

    expect((await getChatVisibleTasks(GROUP, ctx.db)).map((t) => t.id)).toContain(global.id);
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

  /**
   * The production shape of the duplicate (trace `796852a6…`): the model made
   * the identical call twice in one turn. A repeat reports the task it already
   * scheduled — a conflict here would teach it to reassure in prose instead of
   * calling, which is the failure `TaskWriteResult.exists` exists to prevent.
   */
  it("answers a repeated identical timed create with the task already scheduled", async () => {
    const first = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    const again = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);

    expect(first.status).toBe("created");
    expect(again).toMatchObject({
      status: "exists",
      task: { id: first.status === "created" ? first.task.id : "" },
    });
    expect(await getChatVisibleTasks(GROUP, ctx.db)).toHaveLength(1);
  });

  it("still lets the same reminder be scheduled for a different time", async () => {
    await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    const later = await createTaskFromChat(
      { ...timedInput(OTHER_USER), delayMinutes: 90 },
      chatTrigger,
      ctx.db,
    );

    expect(later.status).toBe("created");
    expect(await getChatVisibleTasks(GROUP, ctx.db)).toHaveLength(2);
  });

  it("lets only the creator or the owner change or cancel it", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const created = await createTaskFromChat(timedInput(OTHER_USER), chatTrigger, ctx.db);
    const id = created.status === "created" ? created.task.id : "";

    const stranger = await updateTaskFromChat(
      { chatId: GROUP, userId: "300", id, patch: { instruction: "Remind us to nap." } },
      chatTrigger,
      ctx.db,
    );
    const creator = await updateTaskFromChat(
      { chatId: GROUP, userId: OTHER_USER, id, patch: { instruction: "Remind us to nap." } },
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
