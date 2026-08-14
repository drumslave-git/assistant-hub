import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getToolContext } from "@/server/mcp/context";

/**
 * The outbound toolkit: how a **task fire** says anything to its chat. A timed
 * fire's completion text is never delivered (user decision, 2026-08-13 — the
 * model decides what a task sends, not a hardcoded delivery), so sending is
 * the only path from a fire to the chat, and staying silent is simply not
 * sending.
 *
 * `send_message` here sends a standalone message; its sibling
 * `reply_to_message` (owned by bot-messaging, available in every turn) sends
 * one attached to an earlier message when the fire's context carries the
 * `deliver` binding. `send_message` is deliberately absent from ordinary reply
 * turns twice over: the reply toolset filters it out (`getToolset` — a reply's
 * own text already delivers itself, and a send tool there would double-send),
 * and the handler refuses without the `deliver` binding, so even a stale
 * registry cannot smuggle a send into a reply.
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

const NOT_A_TASK_TURN =
  "Message delivery tools are only available while a task is firing. In this turn your own " +
  "reply is the message — just write it.";

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
      if (!ctx.deliver) return errorResult(NOT_A_TASK_TURN);
      const { messageId } = await ctx.deliver(text);
      return textResult(`Message sent (id ${messageId}).`, { ok: true, message_id: messageId });
    },
  );

}
