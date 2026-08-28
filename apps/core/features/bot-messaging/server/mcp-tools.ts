import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { tryGetToolContext } from "@/server/mcp/context";

/**
 * `reply_to_message` — how a **message-triggered task** says something back.
 * Chat-bound through the tool context, so it cannot act on another
 * conversation. (`set_message_reaction` used to live here; reacting is a
 * Telegram affordance and moved into that app's own MCP server in Phase 5.)
 *
 * `reply_to_message` takes **text and nothing else**. Which message it lands
 * under is the runtime's decision (the message that triggered the task), not the
 * model's. That is deliberate, and it replaced a version that took a
 * `message_id` plus an optional `text`, where the tool retargeted in a reply turn
 * and delivered in a fire. The dual mode cost a real outage: pushed to "call the
 * tool the rule requires", the model put its whole answer into the `text` of a
 * retarget call, which the reply path discarded, and the turn died with nothing
 * to send (trace `224ef60a…`, 2026-08-14). A parameter that is silently ignored
 * in one of two modes is a trap; there is now no parameter and no second mode.
 *
 * Its sibling `send_message` (owned by tasks) is the same shape for a timed
 * fire, which has no triggering message to reply to. Exactly one of the two is
 * offered per turn, decided by the trigger.
 */

export const REPLY_TO_MESSAGE_TOOL = "reply_to_message";

export const BOT_MESSAGING_TOOL_NAMES = [REPLY_TO_MESSAGE_TOOL];

/** Telegram's own per-message cap, matching `send_message`'s. */
const MAX_REPLY_LENGTH = 4000;

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Reply to the message that triggered this rule. Text you merely write in your answer is NOT " +
  "sent anywhere — this call is what delivers it, as a Telegram reply attached to that message, " +
  "so the chat sees what you are responding to and there is no need to quote or describe it. " +
  "Call it once per message you want to appear; several calls send several replies. If the rule " +
  "turns out to require nothing this time, simply do not call it — saying nothing is a valid " +
  "outcome and never an error.";

const replyToMessageOutputSchema = {
  ok: z.boolean(),
  /** The delivered message's own id, when the send succeeded. */
  message_id: z.number().int().nullable(),
};

/** Refusal shape for the reply tool. */
function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, message_id: null },
    isError: true,
  };
}

const NOT_A_REPLY_TURN =
  "Replying to a message is only available while a rule triggered by a message is running. " +
  "In this turn your own answer is the message — just write it.";

/** Register the bot-messaging MCP tools on the shared server. */
export function registerBotMessagingMcpTools(server: McpServer): void {
  server.registerTool(
    REPLY_TO_MESSAGE_TOOL,
    {
      title: "Reply to an earlier message",
      description: REPLY_TO_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_REPLY_LENGTH)
          .describe("The reply text, exactly as the chat should read it"),
      },
      outputSchema: replyToMessageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }) => {
      const context = tryGetToolContext();
      // Two guards, deliberately: `deliver` is the capability, `deliveryKind` is
      // which of the two delivery tools this turn meant to offer. A registry
      // that survived a hot reload can hand the model the wrong one, and a fire
      // answering "replied to the message" about a message that never existed is
      // exactly the kind of quiet lie the tool refusals exist to prevent.
      if (!context?.deliver || context.deliveryKind !== "reply") {
        return refusal(NOT_A_REPLY_TURN);
      }
      const { messageId } = await context.deliver(text);
      return {
        content: [{ type: "text" as const, text: `Reply sent (id ${messageId}).` }],
        structuredContent: { ok: true, message_id: messageId },
      };
    },
  );
}
