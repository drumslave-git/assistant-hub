import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import type { Task } from "../types";
import {
  registerTasksMcpTools,
  TASKS_CREATE_TOOL,
  TASKS_DELETE_TOOL,
  TASKS_GET_TOOL,
  TASKS_LIST_TOOL,
  TASKS_UPDATE_TOOL,
} from "./mcp-tools";

/**
 * The toolkit's contract around the service, for the one thing the service
 * cannot enforce on its own: what the chat is *offered*.
 *
 * A paused task does not exist here (user decision, 2026-08-14) — every read
 * goes through the service's chat-visible functions, an id that resolves to
 * nothing reads as an unknown id, and the update tool has no way to pause
 * anything, because from a chat a cancellation is a deletion. The visibility
 * rule itself is integration-tested against a real database in
 * `tasks.integration.test.ts`.
 */

vi.mock("./service", () => ({
  createTaskFromChat: vi.fn(),
  deleteTaskFromChat: vi.fn(),
  getChatVisibleTask: vi.fn(),
  getChatVisibleTasks: vi.fn(),
  summarizeTask: (task: Task) => task.instruction,
  updateTaskFromChat: vi.fn(),
}));

const service = vi.mocked(await import("./service"));

function task(over: Partial<Task> = {}): Task {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    chatId: "100",
    chatRef: "tg:chat:100",
    chatSource: "tg",
    threadId: null,
    createdByUserId: "100",
    createdByOwner: false,
    assistantId: "assistant-1",
    source: "chat",
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
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...over,
  };
}

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type Registered = {
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

/** Register the tools and return what the MCP server was handed for each. */
function tools(): Record<string, Registered> {
  const registered: Record<string, Registered> = {};
  const server = {
    registerTool: (name: string, config: unknown, handler: unknown) => {
      registered[name] = { config, handler } as Registered;
    },
  } as unknown as McpServer;
  registerTasksMcpTools(server);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trace correlation", () => {
  it("stamps the turn's correlation on a create, so the task joins its turn's flow", async () => {
    service.createTaskFromChat.mockResolvedValue({
      status: "created",
      task: task({ triggerKind: "schedule", runDate: "2026-08-18", timeOfDay: "09:00" }),
    });

    await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "77", correlationId: "tg:chat:100:41" }, () =>
      tools()[TASKS_CREATE_TOOL].handler({
        instruction: "Remind about the contract.",
        trigger: "schedule",
        context: "",
        user_ids: [],
        every_minutes: 0,
        delay_minutes: 0,
        time: "09:00",
        weekdays: [],
        date: "2026-08-18",
      }),
    );

    expect(service.createTaskFromChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "transport",
        actor: "tg:user:77",
        correlationId: "tg:chat:100:41",
      }),
    );
  });
});

describe("reads go through the chat-visible service", () => {
  it("lists what the chat may see, and says so plainly when that is nothing", async () => {
    service.getChatVisibleTasks.mockResolvedValue([]);

    const result = await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "100" }, () =>
      tools()[TASKS_LIST_TOOL].handler({}),
    );

    expect(service.getChatVisibleTasks).toHaveBeenCalledWith("assistant-1", "tg", "100");
    expect(result.content[0].text).toMatch(/no tasks are set for this chat/i);
    expect(result.structuredContent).toMatchObject({ ok: true, count: 0 });
  });

  it("never reports a task as disabled — a listed task is one it can act on", async () => {
    service.getChatVisibleTasks.mockResolvedValue([task()]);

    const result = await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "100" }, () =>
      tools()[TASKS_LIST_TOOL].handler({}),
    );

    expect(result.content[0].text).not.toMatch(/disabled|paused/i);
    expect(result.structuredContent?.tasks).toEqual([
      expect.not.objectContaining({ enabled: expect.anything() }),
    ]);
  });

  it("reads a task the chat cannot see as an unknown id, with the ids it can copy", async () => {
    const visible = task();
    service.getChatVisibleTask.mockResolvedValue(null);
    service.getChatVisibleTasks.mockResolvedValue([visible]);

    const result = await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "100" }, () =>
      tools()[TASKS_GET_TOOL].handler({ id: "99999999-2222-3333-4444-555555555555" }),
    );

    expect(service.getChatVisibleTask).toHaveBeenCalledWith(
      "99999999-2222-3333-4444-555555555555",
      "assistant-1",
      "tg",
      "100",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(visible.id);
  });
});

describe("no pausing from a chat", () => {
  it("offers no way to switch a task off, and says cancelling is deleting", () => {
    const registered = tools();

    expect(Object.keys(registered[TASKS_UPDATE_TOOL].config.inputSchema)).not.toContain("enabled");
    expect(registered[TASKS_UPDATE_TOOL].config.description).not.toMatch(/pause|switch it off/i);
    expect(registered[TASKS_DELETE_TOOL].config.description).toMatch(/cancel/i);
  });

  it("sends no enabled flag to the service, whatever else it was handed", async () => {
    service.updateTaskFromChat.mockResolvedValue({ status: "updated", task: task() });

    await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "100" }, () =>
      tools()[TASKS_UPDATE_TOOL].handler({
        id: task().id,
        instruction: "Answer very briefly.",
        context: "",
        enabled: false,
        user_ids: [],
        applies_to_everyone: null,
        every_minutes: 0,
        delay_minutes: 0,
        time: "",
        weekdays: [],
        date: "",
      }),
    );

    expect(service.updateTaskFromChat).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { instruction: "Answer very briefly." } }),
      expect.anything(),
    );
  });

  it("points at deletion when a change would have been a pause and nothing else", async () => {
    const result = await runWithToolContext({ source: "tg", chatId: "100", assistantId: "assistant-1", userId: "100" }, () =>
      tools()[TASKS_UPDATE_TOOL].handler({
        id: task().id,
        instruction: "",
        context: "",
        enabled: false,
        user_ids: [],
        applies_to_everyone: null,
        every_minutes: 0,
        delay_minutes: 0,
        time: "",
        weekdays: [],
        date: "",
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/delete it/i);
    expect(service.updateTaskFromChat).not.toHaveBeenCalled();
  });
});
