import { describe, expect, it } from "vitest";

import type { ScheduledTask } from "../types";
import { TASKS_CREATE_DESCRIPTION, checkOwnership } from "./mcp-tools";

/**
 * The author rule for the task MCP tools: a chat participant may edit/cancel only
 * tasks they created, and only within their own chat.
 */

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    chatId: "555",
    threadId: null,
    createdByUserId: "100",
    instruction: "call mom",
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
});

describe("TASKS_CREATE_DESCRIPTION", () => {
  it("warns that a fire sees only the instruction, with no chat context", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain(
      "when the task fires you will have ONLY the 'instruction' text: no chat transcript",
    );
  });

  it("requires resolving a chat-specific reference from history before creating", () => {
    expect(TASKS_CREATE_DESCRIPTION).toContain("search the conversation history for it FIRST");
    expect(TASKS_CREATE_DESCRIPTION).toContain("history_search");
    expect(TASKS_CREATE_DESCRIPTION).toContain("history_get_in_range");
    expect(TASKS_CREATE_DESCRIPTION).toContain("write what you found INTO the instruction");
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
