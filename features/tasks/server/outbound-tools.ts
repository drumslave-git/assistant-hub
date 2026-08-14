import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getToolContext } from "@/server/mcp/context";

/**
 * The outbound toolkit: how a **timed fire** says anything to its chat. A fire's
 * completion text is never delivered (user decision, 2026-08-13 — the model
 * decides what a task sends, not a hardcoded delivery), so sending is the only
 * path from a fire to the chat, and staying silent is simply not sending.
 *
 * `send_message` is the standalone half of a pair (user decision, 2026-08-14):
 * a timed fire speaks into the chat unprompted and has nothing to reply to, so
 * it gets this; a `message`-triggered task is answering the message that opened
 * it, so it gets `reply_to_message` instead. Exactly one of the two is offered
 * per turn, and an ordinary reply turn gets neither — its own text is already
 * the delivery, and a send tool there would double-send.
 *
 * That carve-out is enforced twice: `getToolset` withholds the tool, and the
 * handler refuses without the matching context binding, so even a stale registry
 * cannot smuggle a send into the wrong kind of turn.
 *
 * The chat is bound per turn via the tool context, like every chat-bound tool:
 * a task can only ever speak into its own chat (user decision, 2026-08-13 — no
 * cross-chat sends).
 */

export const SEND_MESSAGE_TOOL = "send_message";

export const TASKS_OUTBOUND_TOOL_NAMES = [SEND_MESSAGE_TOOL];

const MAX_OUTBOUND_LENGTH = 4000;

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

const NOT_A_SEND_TURN =
  "Sending a standalone message is only available while a timed task is firing. If you are " +
  "acting on a message somebody posted, reply to it instead; in an ordinary turn your own " +
  "answer is the message — just write it.";

/** Register the outbound MCP tools on the shared server. */
export function registerTasksOutboundMcpTools(server: McpServer): void {
  server.registerTool(
    SEND_MESSAGE_TOOL,
    {
      title: "Send a message to the chat",
      description:
        "Send a message to this chat, as yourself. This is how anything you want the people " +
        "here to see is actually delivered while you execute a task — text you merely write " +
        "in your answer is NOT sent anywhere. Call it once per message you want to appear; " +
        "several calls send several messages. If the task turns out to need no message this " +
        "time (nothing to report, condition not met), simply do not call it — saying nothing " +
        "is a valid outcome and never an error.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_OUTBOUND_LENGTH)
          .describe("The message text, exactly as the chat should read it"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }) => {
      const ctx = getToolContext();
      // `deliver` is the capability; `deliveryKind` is which delivery tool this
      // turn meant to offer. See the reply tool for why both are checked.
      if (!ctx.deliver || ctx.deliveryKind !== "send") return errorResult(NOT_A_SEND_TURN);
      const { messageId } = await ctx.deliver(text);
      return textResult(`Message sent (id ${messageId}).`, { ok: true, message_id: messageId });
    },
  );

}
