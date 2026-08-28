import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { registerBotMessagingMcpTools, REPLY_TO_MESSAGE_TOOL } from "./mcp-tools";

/**
 * `reply_to_message` is about *not* lying to the chat: it delivers only in
 * the turn kind that has a message to answer, and refuses audibly otherwise —
 * a silent no-op would leave the model saying "here it is" pointing at
 * nothing. (The reaction tool this file also covered now lives in apps/tg,
 * tested against that app's own MCP endpoint.)
 */

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent: { ok: boolean; message_id: number | null };
  isError?: boolean;
}

/** Register the toolkit and return the tool's handler, as MCP would invoke it. */
function toolHandler() {
  const registered: Record<string, unknown> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      registered[name] = handler;
    },
  } as unknown as McpServer;
  registerBotMessagingMcpTools(server);
  return registered[REPLY_TO_MESSAGE_TOOL] as (args: { text: string }) => Promise<ToolResult>;
}

describe("reply_to_message", () => {
  /** A turn opened by a `message` task: the one kind that may reply. */
  function replyTurn(sent: string[]) {
    return {
      chatId: "-100",
      deliveryKind: "reply" as const,
      deliver: async (text: string) => {
        sent.push(text);
        return { messageId: 555 };
      },
    };
  }

  it("delivers the text and reports the sent message's own id", async () => {
    const sent: string[] = [];

    const result = await runWithToolContext(replyTurn(sent), () =>
      toolHandler()({ text: "you are wrong about that" }),
    );

    expect(sent).toEqual(["you are wrong about that"]);
    expect(result.structuredContent).toEqual({ ok: true, message_id: 555 });
  });

  it("sends once per call, so two calls are two messages", async () => {
    const sent: string[] = [];
    const handler = toolHandler();

    await runWithToolContext(replyTurn(sent), async () => {
      await handler({ text: "first" });
      await handler({ text: "second" });
    });

    expect(sent).toEqual(["first", "second"]);
  });

  it("refuses in an ordinary reply turn, where the answer is already the message", async () => {
    // The turn that has no delivery binding is the one whose own text is on its
    // way to the chat; delivering here too would post the reply twice.
    const result = await runWithToolContext({ chatId: "-100" }, () =>
      toolHandler()({ text: "hello" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("your own answer is the message");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null });
  });

  it("refuses in a fire, which has no message to reply to", async () => {
    // A stale registry can hand the model the wrong delivery tool. Answering
    // "replied to the message" in a turn where no message triggered anything is
    // exactly the quiet lie the refusals exist to prevent, so the binding's kind
    // is checked, not merely its presence.
    const sent: string[] = [];
    const result = await runWithToolContext(
      {
        chatId: "-100",
        deliveryKind: "send",
        deliver: async (text: string) => {
          sent.push(text);
          return { messageId: 1 };
        },
      },
      () => toolHandler()({ text: "hello" }),
    );

    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });
});
