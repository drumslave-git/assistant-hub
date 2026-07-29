import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import {
  registerChatRulesMcpTools,
  RULES_CREATE_DESCRIPTION,
  RULES_CREATE_TOOL,
  RULES_DELETE_TOOL,
  RULES_LIST_TOOL,
  RULES_UPDATE_TOOL,
} from "./mcp-tools";
import type { ChatRule } from "./schema";

/**
 * The toolkit's contract around the service: every tool works on the *bound*
 * chat, a refusal comes back as text the model can relay rather than as a thrown
 * error, and a partial update sends only the fields the model actually supplied.
 * The permission and scope logic itself is integration-tested against a real
 * database in `chat-rules.integration.test.ts`.
 */

vi.mock("./service", () => ({
  getRulesForChat: vi.fn(),
  createRuleFromChat: vi.fn(),
  updateRuleFromChat: vi.fn(),
  deleteRuleFromChat: vi.fn(),
}));

const service = vi.mocked(await import("./service"));

function rule(over: Partial<ChatRule> = {}): ChatRule {
  return {
    id: "rule-1",
    chatId: "-1001",
    text: "Answer briefly.",
    trigger: "on-reply",
    enabled: true,
    createdByUserId: "77",
    source: "chat",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
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
  registerChatRulesMcpTools(server);
  return registered;
}

const inChat = <T,>(fn: () => Promise<T>) =>
  runWithToolContext({ chatId: "-1001", userId: "77" }, fn);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rules_create description", () => {
  /**
   * Pinned because it is the whole feature's usability on a small model: almost
   * nobody says "rule", and the two neighbouring tools (memory, scheduled tasks)
   * are what it gets confused with.
   */
  it("covers the phrasings people use and separates the neighbouring tools", () => {
    expect(RULES_CREATE_DESCRIPTION).toMatch(/from now on/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/never … again|never/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/whenever someone sends/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/memory tool/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/scheduled-task tool/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/self-contained/i);
  });

  /**
   * The clauses that exist because of trace `f33e1ede…` (2026-07-29): the model
   * identified `rules_create` as the right tool, then argued itself out of the
   * call on two beliefs — that its own earlier "got it" had already stored the
   * rule, and that calling again would duplicate it.
   */
  it("refuses its own past agreement as proof, and says a repeat is safe", () => {
    expect(RULES_CREATE_DESCRIPTION).toMatch(/is NOT the rule being saved/);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/Calling it twice is safe/);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/never skip the call to avoid duplicating/i);
    expect(RULES_CREATE_DESCRIPTION).toMatch(/repeating the same instruction is telling you/i);
    // The only evidence of stored state is a tool result.
    expect(RULES_CREATE_DESCRIPTION).toMatch(/call rules_list/);
  });
});

describe("rules_list", () => {
  it("lists the bound chat's rules with their ids, marking global and paused ones", async () => {
    service.getRulesForChat.mockResolvedValue([
      rule(),
      rule({ id: "rule-2", chatId: null, text: "Never swear.", enabled: false }),
    ]);
    const handlers = toolHandlers();

    const result = await inChat(() => handlers[RULES_LIST_TOOL]({}));

    expect(service.getRulesForChat).toHaveBeenCalledWith("-1001");
    expect(result.content[0].text).toContain("rule-1");
    expect(result.content[0].text).toContain("disabled");
    expect(result.content[0].text).toContain("every chat");
    expect(result.structuredContent).toMatchObject({ ok: true, count: 2 });
  });

  it("says so plainly when the chat has no rules", async () => {
    service.getRulesForChat.mockResolvedValue([]);
    const handlers = toolHandlers();

    const result = await inChat(() => handlers[RULES_LIST_TOOL]({}));

    expect(result.content[0].text).toMatch(/no rules are set/i);
  });
});

describe("rules_create", () => {
  it("writes for the bound chat with the caller as author", async () => {
    service.createRuleFromChat.mockResolvedValue({ status: "created", rule: rule() });
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_CREATE_TOOL]({ text: "  Answer briefly.  ", trigger: "on-reply" }),
    );

    expect(service.createRuleFromChat).toHaveBeenCalledWith(
      { chatId: "-1001", userId: "77", text: "Answer briefly.", trigger: "on-reply" },
      expect.objectContaining({ kind: "telegram", actor: "77", correlationId: "-1001" }),
    );
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.content[0].text).toContain("Answer briefly.");
  });

  it("reports an already-present rule as success, not as an error", async () => {
    // A repeat must never look like a failure: a tool that punishes repeating is
    // what taught the model to answer in prose instead of calling it.
    service.createRuleFromChat.mockResolvedValue({ status: "exists", rule: rule() });
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_CREATE_TOOL]({ text: "Answer briefly.", trigger: "on-reply" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, already_present: true });
    expect(result.content[0].text).toMatch(/already in force/i);
  });

  it("relays a permission refusal instead of failing the turn", async () => {
    service.createRuleFromChat.mockResolvedValue({
      status: "denied",
      reason: "Only the bot owner can change this group's rules.",
    });
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_CREATE_TOOL]({ text: "Answer briefly.", trigger: "on-reply" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only the bot owner/i);
  });
});

describe("rules_update", () => {
  it("sends only the fields the model supplied", async () => {
    service.updateRuleFromChat.mockResolvedValue({
      status: "updated",
      rule: rule({ enabled: false }),
    });
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_UPDATE_TOOL]({ id: "rule-1", text: "", trigger: "", enabled: false }),
    );

    expect(service.updateRuleFromChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rule-1", patch: { enabled: false } }),
      expect.anything(),
    );
    expect(result.content[0].text).toMatch(/paused/i);
  });

  it("asks for something to change rather than sending an empty patch", async () => {
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_UPDATE_TOOL]({ id: "rule-1", text: "", trigger: "", enabled: null }),
    );

    expect(result.isError).toBe(true);
    expect(service.updateRuleFromChat).not.toHaveBeenCalled();
  });

  it("relays an unknown id as a usable message", async () => {
    service.updateRuleFromChat.mockResolvedValue({ status: "not_found" });
    const handlers = toolHandlers();

    const result = await inChat(() =>
      handlers[RULES_UPDATE_TOOL]({ id: "nope", text: "x", trigger: "", enabled: null }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no rule with that id/i);
  });
});

describe("rules_delete", () => {
  it("deletes by id in the bound chat", async () => {
    service.deleteRuleFromChat.mockResolvedValue({ status: "deleted", id: "rule-1" });
    const handlers = toolHandlers();

    const result = await inChat(() => handlers[RULES_DELETE_TOOL]({ id: "rule-1" }));

    expect(service.deleteRuleFromChat).toHaveBeenCalledWith(
      { chatId: "-1001", userId: "77", id: "rule-1" },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ ok: true, id: "rule-1" });
  });

  it("relays the read-only refusal for a global rule", async () => {
    service.deleteRuleFromChat.mockResolvedValue({
      status: "denied",
      reason: "That rule applies to every chat and can only be changed by the operator in the dashboard.",
    });
    const handlers = toolHandlers();

    const result = await inChat(() => handlers[RULES_DELETE_TOOL]({ id: "rule-2" }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/every chat/i);
  });
});
