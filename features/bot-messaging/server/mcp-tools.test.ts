import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { registerBotMessagingMcpTools, REPLY_TO_MESSAGE_TOOL } from "./mcp-tools";

/**
 * The reply-targeting tool has two jobs and both are about *not* lying to the
 * chat: it must move the turn's reply only when the target really exists in this
 * conversation, and it must refuse audibly when it cannot — a silent no-op would
 * leave the model saying "here it is" pointing at nothing.
 */

vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));
vi.mock("@/features/history/server/repository", () => ({
  getChatMessagesByTelegramIds: vi.fn(),
}));

const { getChatMessagesByTelegramIds } = await import("@/features/history/server/repository");
const mockedLookup = vi.mocked(getChatMessagesByTelegramIds);

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent: { ok: boolean; message_id: number | null };
  isError?: boolean;
}

/** Register the tool and return its handler, as the MCP server would invoke it. */
function toolHandler() {
  const registered: Record<string, unknown> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      registered[name] = handler;
    },
  } as unknown as McpServer;
  registerBotMessagingMcpTools(server);
  return registered[REPLY_TO_MESSAGE_TOOL] as (args: { message_id: number }) => Promise<ToolResult>;
}

/** A mirrored message, as the lookup returns it (only the id is read). */
function mirrored(telegramMessageId: number) {
  return [{ telegramMessageId }] as never;
}

describe("reply_to_message", () => {
  it("moves the turn's reply target to the requested message", async () => {
    mockedLookup.mockResolvedValue(mirrored(4321));
    const targets: number[] = [];

    const result = await runWithToolContext(
      { chatId: "-100", setReplyTarget: (id) => targets.push(id) },
      () => toolHandler()({ message_id: 4321 }),
    );

    expect(targets).toEqual([4321]);
    expect(result.structuredContent).toEqual({ ok: true, message_id: 4321 });
    // The chat sees the quote, so telling the model to quote it too would double it.
    expect(result.content[0].text).toContain("no need to quote");
  });

  it("scopes the lookup to the bound chat, never a chat the model names", async () => {
    mockedLookup.mockResolvedValue(mirrored(7));
    await runWithToolContext({ chatId: "-100", setReplyTarget: () => {} }, () =>
      toolHandler()({ message_id: 7 }),
    );
    expect(mockedLookup).toHaveBeenCalledWith(expect.anything(), "-100", [7]);
  });

  it("refuses an id that is not in this chat, and moves nothing", async () => {
    // The failure this prevents: Telegram rejects a send whose reply target it
    // cannot find, so a guessed id would cost the whole reply.
    mockedLookup.mockResolvedValue([] as never);
    const targets: number[] = [];

    const result = await runWithToolContext(
      { chatId: "-100", setReplyTarget: (id) => targets.push(id) },
      () => toolHandler()({ message_id: 999 }),
    );

    expect(targets).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No message #999 in this chat");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null });
  });

  it("refuses when the turn has no reply to aim, without touching the database", async () => {
    mockedLookup.mockClear();

    // A bound turn with no sink — e.g. a text-only scheduled-task fire.
    const result = await runWithToolContext({ chatId: "-100" }, () =>
      toolHandler()({ message_id: 4321 }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no reply to attach");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("lets a later call replace an earlier target", async () => {
    mockedLookup.mockResolvedValue(mirrored(1));
    const targets: number[] = [];
    const handler = toolHandler();

    await runWithToolContext({ chatId: "-100", setReplyTarget: (id) => targets.push(id) }, async () => {
      await handler({ message_id: 1 });
      await handler({ message_id: 2 });
    });

    // The pipeline reads the last value written, so the tool needs no state of
    // its own — but the contract is worth pinning, since the description says so.
    expect(targets).toEqual([1, 2]);
  });
});
