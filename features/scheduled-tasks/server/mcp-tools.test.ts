import { describe, expect, it } from "vitest";

import type { ScheduledTask } from "../types";
import {
  TASKS_CREATE_DESCRIPTION,
  TASKS_UPDATE_DESCRIPTION,
  checkOwnership,
  isTaskId,
  unknownTaskText,
} from "./mcp-tools";

/**
 * The author rule for the task MCP tools: a chat participant may edit/cancel only
 * tasks they created, and only within their own chat — plus how a mutation that
 * names an id no task has explains itself.
 */

/**
 * The id a `tasks_list` result was copied from, and the same id with one
 * character dropped — the production failure the miss text was written for
 * (2026-08-05): the model could not tell a mistyped id from a vanished task.
 */
const LIVE_ID = "9c4a1f28-77b3-4e5a-b0d6-2f81ac309e47";
const TRUNCATED_ID = "9c4a1f28-77b3-4e5a-b0d6-2f81ac309e4";

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    chatId: "555",
    threadId: null,
    createdByUserId: "100",
    instruction: "call mom",
    context: null,
    scheduleKind: "daily",
    timeOfDay: "09:00",
    weekdays: null,
    runDate: null,
    enabled: true,
    attempts: 0,
    recentDeliveries: [],
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

describe("checkOwnership", () => {
  it("allows the author to manage their own task in their chat", () => {
    expect(checkOwnership(task(), { chatId: "555", userId: "100" }, "task-1")).toBeNull();
  });

  it("denies another user in the same chat", () => {
    const denied = checkOwnership(task(), { chatId: "555", userId: "200" }, "task-1");
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toMatch(/created by someone else|only change tasks you created/i);
  });

  it("denies when the caller has no user id", () => {
    expect(checkOwnership(task(), { chatId: "555", userId: null }, "task-1")?.isError).toBe(true);
  });

  it("denies a dashboard-created task (no author) for any chat user", () => {
    const denied = checkOwnership(
      task({ createdByUserId: null }),
      { chatId: "555", userId: "100" },
      "task-1",
    );
    expect(denied?.isError).toBe(true);
  });

  it("denies a task in a different chat as 'not in this chat'", () => {
    const denied = checkOwnership(task({ chatId: "999" }), { chatId: "555", userId: "100" }, "task-1");
    expect(denied?.content[0].text).toMatch(/in this chat/i);
  });

  it("denies a missing task", () => {
    expect(checkOwnership(null, { chatId: "555", userId: "100" }, "task-1")?.isError).toBe(true);
  });

  it("hands the chat's ids back on a miss, so the next round can retry", () => {
    const denied = checkOwnership(null, { chatId: "555", userId: "100" }, LIVE_ID, [LIVE_ID]);
    expect(denied?.content[0].text).toContain(LIVE_ID);
  });
});

describe("isTaskId", () => {
  it("accepts a uuid, in either case and with surrounding space", () => {
    expect(isTaskId(LIVE_ID)).toBe(true);
    expect(isTaskId(` ${LIVE_ID.toUpperCase()} `)).toBe(true);
  });

  it("rejects an id that lost a character in the copy", () => {
    expect(isTaskId(TRUNCATED_ID)).toBe(false);
  });

  it("rejects other non-ids", () => {
    expect(isTaskId("")).toBe(false);
    expect(isTaskId("task-1")).toBe(false);
    expect(isTaskId(`${LIVE_ID}extra`)).toBe(false);
  });
});

describe("unknownTaskText", () => {
  it("names a malformed id as malformed, not as a task that is gone", () => {
    const text = unknownTaskText(TRUNCATED_ID, [LIVE_ID]);
    expect(text).toContain("not a valid task id");
    expect(text).toContain("truncated or mistyped");
  });

  it("lists the chat's ids to copy from", () => {
    const other = "3b7e0d51-6c22-4a90-8f13-5d0e9b74a1c8";
    const text = unknownTaskText(TRUNCATED_ID, [LIVE_ID, other]);
    expect(text).toContain(LIVE_ID);
    expect(text).toContain(other);
    expect(text).toContain("character for character");
  });

  it("does not call a well-formed id malformed", () => {
    const text = unknownTaskText(LIVE_ID, []);
    expect(text).not.toContain("not a valid task id");
    expect(text).toContain("This chat has no scheduled tasks.");
  });

  it("always says the id is not in this chat", () => {
    expect(unknownTaskText(LIVE_ID, [])).toContain("in this chat");
    expect(unknownTaskText(TRUNCATED_ID, [LIVE_ID])).toContain("in this chat");
  });
});

describe("TASKS_CREATE_DESCRIPTION", () => {
  it("warns that a fire sees only the stored texts, with no chat context", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain(
      "when the task fires you will have ONLY the stored 'instruction' and 'context' texts: no chat transcript",
    );
  });

  it("requires gathering context — from view or history — before creating", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain("GATHER CONTEXT BEFORE CREATING");
    expect(TASKS_CREATE_DESCRIPTION).toContain("history_search");
    expect(TASKS_CREATE_DESCRIPTION).toContain("history_get_in_range");
    expect(TASKS_CREATE_DESCRIPTION).toContain("save it in 'context'");
  });

  it("says to ask rather than store an empty pointer when the lookup fails", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain(
      "ask the user what it refers to instead of storing the empty phrasing",
    );
  });

  it("keeps the third-person/joke schedule rule from the earlier fix", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain("a recurring bit or gag is still a schedule request");
  });
});

describe("TASKS_UPDATE_DESCRIPTION", () => {
  it("carries the same fire-sees-only-the-stored-texts warning as create", () => {
    expect(TASKS_UPDATE_DESCRIPTION).toContain(
      "when the task fires you will have ONLY the stored 'instruction' and 'context' texts",
    );
  });

  it("requires gathering context — from view or history — before updating", () => {
    expect(TASKS_UPDATE_DESCRIPTION).toContain("GATHER CONTEXT BEFORE UPDATING");
    expect(TASKS_UPDATE_DESCRIPTION).toContain("history_search");
    expect(TASKS_UPDATE_DESCRIPTION).toContain("history_get_in_range");
    expect(TASKS_UPDATE_DESCRIPTION).toContain("pass it as 'context'");
  });

  it("names the case it was written for: the user supplying the missing background", () => {
    expect(TASKS_UPDATE_DESCRIPTION).toContain(
      "the user telling you what a task's person/event/joke/topic actually is IS such an update",
    );
  });

  it("warns against leaving stale context behind a changed instruction", () => {
    expect(TASKS_UPDATE_DESCRIPTION).toContain(
      "Changing the instruction while leaving context describing the old one",
    );
  });

  it("exempts a pure schedule or enable/disable change", () => {
    expect(TASKS_UPDATE_DESCRIPTION).toContain(
      "Updating only the time, schedule or 'enabled' needs no context",
    );
  });
});
