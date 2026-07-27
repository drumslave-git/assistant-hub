import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import type { Specialist } from "./schema";
import {
  registerSpecialistsMcpTools,
  SPECIALIST_DELETE_TOOL,
  SPECIALIST_LIST_TOOL,
  SPECIALIST_QUERY_TOOL,
  SPECIALIST_SAVE_TOOL,
  SPECIALIST_SWITCH_TOOL,
  SPECIALIST_UPDATE_TOOL,
} from "./mcp-tools";

/**
 * The toolkit's contract around the service: every data tool resolves the
 * *current chat's* active specialist and returns the clear no-active-specialist
 * result when there is none (never guessing a scope), and the switch tool
 * relays the service's permission verdicts. The scope/permission logic itself
 * is integration-tested against a real database in
 * `specialists.integration.test.ts`.
 */

vi.mock("./service", () => ({
  getActiveSpecialist: vi.fn(),
  getSpecialistsView: vi.fn(),
  queryEntriesForChat: vi.fn(),
  saveEntry: vi.fn(),
  switchSpecialistFromChat: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

const service = vi.mocked(await import("./service"));

function specialist(over: Partial<Specialist> = {}): Specialist {
  return {
    id: "spec-1",
    name: "Journal",
    description: "A journal.",
    instructions: "Keep a journal.",
    dataScope: "per-chat",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    specialistId: "spec-1",
    chatId: "100",
    authorUserId: "100",
    collection: "journal",
    payload: { note: "hello" },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Register the tools and return their handlers, as the MCP server would invoke them. */
function toolHandlers() {
  const registered: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      registered[name] = handler as (args: Record<string, unknown>) => Promise<ToolResult>;
    },
  } as unknown as McpServer;
  registerSpecialistsMcpTools(server);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("no active specialist", () => {
  it.each([
    [SPECIALIST_SAVE_TOOL, { collection: "journal", payload: { note: "x" } }],
    [SPECIALIST_QUERY_TOOL, { collection: "", contains: "", limit: 50 }],
    [SPECIALIST_UPDATE_TOOL, { id: "entry-1", payload: { note: "x" } }],
    [SPECIALIST_DELETE_TOOL, { id: "entry-1" }],
  ])("%s returns the clear unscoped result and mutates nothing", async (tool, args) => {
    service.getActiveSpecialist.mockResolvedValue(null);
    const handlers = toolHandlers();

    const result = await runWithToolContext({ chatId: "100", userId: "100" }, () =>
      handlers[tool](args),
    );

    expect(result.content[0].text).toMatch(/no specialist is active in this chat/i);
    expect(result.structuredContent).toMatchObject({ ok: false, reason: "no_active_specialist" });
    expect(service.saveEntry).not.toHaveBeenCalled();
    expect(service.updateEntry).not.toHaveBeenCalled();
    expect(service.deleteEntry).not.toHaveBeenCalled();
    expect(service.queryEntriesForChat).not.toHaveBeenCalled();
  });
});

describe("save", () => {
  it("saves under the bound chat with the caller as author and a normalized collection", async () => {
    service.getActiveSpecialist.mockResolvedValue(specialist());
    service.saveEntry.mockResolvedValue(entry());
    const handlers = toolHandlers();

    const result = await runWithToolContext({ chatId: "100", userId: "77" }, () =>
      handlers[SPECIALIST_SAVE_TOOL]({ collection: "  Journal ", payload: { note: "hello" } }),
    );

    expect(service.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "100",
        authorUserId: "77",
        collection: "journal",
        payload: { note: "hello" },
      }),
      expect.objectContaining({ kind: "telegram", actor: "77", correlationId: "100" }),
    );
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.content[0].text).toContain("entry-1");
  });
});

describe("query", () => {
  it("returns full payloads and the existing collections", async () => {
    service.getActiveSpecialist.mockResolvedValue(specialist());
    service.queryEntriesForChat.mockResolvedValue({
      entries: [entry()],
      collections: ["journal"],
    });
    const handlers = toolHandlers();

    const result = await runWithToolContext({ chatId: "100" }, () =>
      handlers[SPECIALIST_QUERY_TOOL]({ collection: "", contains: "", limit: 50 }),
    );

    expect(result.content[0].text).toContain('{"note":"hello"}');
    expect(result.structuredContent).toMatchObject({
      ok: true,
      count: 1,
      collections: ["journal"],
    });
  });
});

describe("switch", () => {
  it("relays a denial as an error result the model can repeat", async () => {
    service.switchSpecialistFromChat.mockResolvedValue({
      status: "denied",
      reason: "Only the bot owner can switch this group's specialist.",
    });
    const handlers = toolHandlers();

    const result = await runWithToolContext({ chatId: "-1001", userId: "200" }, () =>
      handlers[SPECIALIST_SWITCH_TOOL]({ name: "Journal" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only the bot owner/i);
  });

  it("confirms a switch, and treats an empty name as deactivation", async () => {
    service.switchSpecialistFromChat.mockResolvedValue({
      status: "switched",
      specialist: specialist(),
    });
    const handlers = toolHandlers();

    const switched = await runWithToolContext({ chatId: "100", userId: "100" }, () =>
      handlers[SPECIALIST_SWITCH_TOOL]({ name: "Journal" }),
    );
    expect(switched.content[0].text).toContain('"Journal" is now active');

    service.switchSpecialistFromChat.mockResolvedValue({ status: "cleared" });
    const cleared = await runWithToolContext({ chatId: "100", userId: "100" }, () =>
      handlers[SPECIALIST_SWITCH_TOOL]({ name: "  " }),
    );
    expect(service.switchSpecialistFromChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: "100", userId: "100", specialistName: null }),
      expect.anything(),
    );
    expect(cleared.content[0].text).toMatch(/deactivated/i);
  });
});

describe("list", () => {
  it("lists specialists and marks the one active in this chat", async () => {
    service.getSpecialistsView.mockResolvedValue({
      specialists: [specialist(), specialist({ id: "spec-2", name: "Groceries", description: "" })],
      assignments: [],
    });
    service.getActiveSpecialist.mockResolvedValue(specialist());
    const handlers = toolHandlers();

    const result = await runWithToolContext({ chatId: "100" }, () =>
      handlers[SPECIALIST_LIST_TOOL]({}),
    );

    expect(result.content[0].text).toContain("Journal (active in this chat)");
    expect(result.content[0].text).toContain("Groceries: (no description)");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      active: { id: "spec-1", name: "Journal" },
    });
  });
});
