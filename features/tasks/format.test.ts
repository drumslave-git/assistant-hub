import { describe, expect, it } from "vitest";

import {
  appliesToSender,
  buildStandingTasksBlock,
  buildTaskTriggerDirective,
  messageTasks,
  promptTasks,
  resolveTaskAuthority,
  sameTargets,
  TASK_ENFORCEMENT_DIRECTIVE,
  tasksForSender,
} from "./format";
import type { Task } from "./types";

/**
 * Prompt composition for tasks: what the model is actually told. These are the
 * only place a standing task's wording is decided, so the assertions are about
 * the contract (numbering, scope marking, the action/honesty clauses), not
 * phrasing word for word. Carried over from the chat-rules feature the tasks
 * feature absorbed.
 */

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    chatId: "-1001",
    threadId: null,
    createdByUserId: null,
    source: "dashboard",
    instruction: "Answer briefly.",
    context: null,
    triggerKind: "on-reply",
    targetUserIds: [],
    everyMinutes: null,
    delayMinutes: null,
    timeOfDay: null,
    weekdays: null,
    runDate: null,
    enabled: true,
    attempts: 0,
    recentDeliveries: [],
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...over,
  };
}

describe("buildStandingTasksBlock", () => {
  it("returns null when there is nothing to say", () => {
    expect(buildStandingTasksBlock([])).toBeNull();
    expect(buildStandingTasksBlock([{ instruction: "   " }])).toBeNull();
  });

  it("numbers the tasks and keeps their text verbatim", () => {
    const block = buildStandingTasksBlock([
      { instruction: "Answer briefly." },
      { instruction: "Download video links." },
    ]);
    expect(block).toContain("1. Answer briefly.");
    expect(block).toContain("2. Download video links.");
  });

  it("marks a global task as applying everywhere", () => {
    const block = buildStandingTasksBlock([{ instruction: "Never swear.", chatId: null }]);
    expect(block).toContain("Never swear. (applies in every chat)");
  });

  it("binds an action task to a tool call and allows an honest failure", () => {
    const block = buildStandingTasksBlock([{ instruction: "Download video links." }])!;
    // The three clauses that make a standing task more than decoration.
    expect(block).toMatch(/binding instructions/i);
    expect(block).toMatch(/calling the tool/i);
    expect(block).toMatch(/refuses|not allowed/i);
  });
});

describe("buildTaskTriggerDirective", () => {
  it("says nobody addressed the bot and lists what matched", () => {
    const directive = buildTaskTriggerDirective([{ instruction: "Download video links." }]);
    expect(directive).toMatch(/nobody in this chat addressed you/i);
    expect(directive).toContain("1. Download video links.");
    // The narrowing clause: a task-opened turn is not an invitation to chat.
    expect(directive).toMatch(/nothing else/i);
  });
});

describe("TASK_ENFORCEMENT_DIRECTIVE", () => {
  it("names the failure, demands the call, and leaves an honest way out", () => {
    // The escape hatch is load-bearing, not politeness: a model cornered into
    // calling *something* picks the wrong tool, and "I could not" is a correct
    // answer to a task no available tool can carry out.
    expect(TASK_ENFORCEMENT_DIRECTIVE).toMatch(/called no tool/i);
    expect(TASK_ENFORCEMENT_DIRECTIVE).toMatch(/will not be sent/i);
    expect(TASK_ENFORCEMENT_DIRECTIVE).toMatch(/could not do it/i);
  });
});

describe("task selection", () => {
  it("composes only enabled prompt kinds, and matches only enabled `message` ones", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", enabled: false }),
      task({ id: "c", triggerKind: "message" }),
      task({ id: "d", triggerKind: "message", enabled: false }),
      // Timed kinds never enter a prompt — they fire on their own clock.
      task({ id: "e", triggerKind: "interval", everyMinutes: 10 }),
      task({ id: "f", triggerKind: "schedule", timeOfDay: "09:00" }),
    ];
    expect(promptTasks(tasks).map((t) => t.id)).toEqual(["a", "c"]);
    expect(messageTasks(tasks).map((t) => t.id)).toEqual(["c"]);
  });
});

/**
 * Who a task reaches. A task naming people is filtered out of every other
 * sender's turn before it can reach a prompt (user decision, 2026-08-13), so
 * this selection *is* the feature — the model is never asked to judge whether
 * an instruction about somebody else applies to this message.
 */
describe("sender targeting", () => {
  const ALICE = "11";
  const BOB = "22";

  it("applies a task naming nobody to everyone, including a turn with no sender", () => {
    expect(appliesToSender(task(), ALICE)).toBe(true);
    expect(appliesToSender(task(), null)).toBe(true);
  });

  it("applies a task naming people only to those senders", () => {
    const targeted = task({ targetUserIds: [ALICE] });
    expect(appliesToSender(targeted, ALICE)).toBe(true);
    expect(appliesToSender(targeted, BOB)).toBe(false);
  });

  it("drops a task naming people from a turn nobody sent (a timed fire)", () => {
    expect(appliesToSender(task({ targetUserIds: [ALICE] }), null)).toBe(false);
  });

  it("keeps the untargeted tasks and the ones naming this sender", () => {
    const tasks = [
      task({ id: "everyone" }),
      task({ id: "alice", targetUserIds: [ALICE] }),
      task({ id: "bob", targetUserIds: [BOB] }),
      task({ id: "both", targetUserIds: [ALICE, BOB] }),
    ];

    expect(tasksForSender(tasks, ALICE).map((t) => t.id)).toEqual(["everyone", "alice", "both"]);
    expect(tasksForSender(tasks, null).map((t) => t.id)).toEqual(["everyone"]);
  });
});

describe("sameTargets", () => {
  it("compares the people named, not the order they were named in", () => {
    expect(sameTargets([], [])).toBe(true);
    expect(sameTargets(["11", "22"], ["22", "11"])).toBe(true);
    expect(sameTargets(["11"], ["11", "22"])).toBe(false);
    expect(sameTargets(["11"], [])).toBe(false);
  });
});

/**
 * Whose rights a task-driven action carries. A task is its author's standing
 * order, so the author's permissions apply and not the sender's ("rule creator
 * beats message source" — user decision, 2026-07-29). Only the owner is a
 * privileged identity here, so elevation is exactly: a task the owner wrote, or
 * one written in the operator-only dashboard.
 */
describe("resolveTaskAuthority", () => {
  const OWNER = "1";

  it("elevates to the owner for a task the owner set from chat", () => {
    const matched = [task({ source: "chat", createdByUserId: OWNER })];
    expect(resolveTaskAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates to the owner for a task the operator set in the dashboard", () => {
    const matched = [task({ source: "dashboard", createdByUserId: null })];
    expect(resolveTaskAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates nothing for a task an ordinary user set in their own DM", () => {
    const matched = [task({ source: "chat", createdByUserId: "77" })];
    expect(resolveTaskAuthority(matched, OWNER)).toBeNull();
  });

  it("elevates when any one of the matched tasks qualifies", () => {
    const matched = [
      task({ id: "a", source: "chat", createdByUserId: "77" }),
      task({ id: "b", source: "chat", createdByUserId: OWNER }),
    ];
    expect(resolveTaskAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates nothing when nothing matched", () => {
    expect(resolveTaskAuthority([], OWNER)).toBeNull();
  });

  it("elevates nothing when no owner is configured", () => {
    const matched = [task({ source: "dashboard", createdByUserId: null })];
    expect(resolveTaskAuthority(matched, null)).toBeNull();
  });
});
