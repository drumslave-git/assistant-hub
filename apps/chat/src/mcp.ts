import {
  readTurnMeta,
  toolDeliveryResult,
  type TurnToolMeta,
} from "@assistant-hub/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ChatDb } from "./db";
import { appendMessage, getThreadById } from "./store";

/**
 * This app's own MCP server (PLAN.md: "it exposes an MCP server for its
 * outbound actions") — tg's twin, minus what a web thread does not have.
 *
 * There is no reaction tool here, and that is the whole answer to "what does
 * a source do about an affordance it lacks": it does not offer the tool. The
 * model then never sees an action it would be told afterwards it cannot take.
 *
 * Every call carries its turn as MCP `_meta`, so a thread is a fact of the
 * turn rather than an argument a model could aim at somebody else's.
 */

export const CHAT_MCP_TOOLS = ["reply_to_message", "send_message"] as const;

/** Generous next to Telegram's 4000: a browser renders whatever it is given. */
const MAX_MESSAGE_LENGTH = 8000;

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Reply to the message that triggered this rule. Text you merely write in your answer is NOT " +
  "sent anywhere — this call is what delivers it, attached to the message you are responding " +
  "to. Call it once per message you want to appear; several calls send several replies. If the " +
  "rule turns out to require nothing this time, simply do not call it — saying nothing is a " +
  "valid outcome and never an error.";

const SEND_MESSAGE_DESCRIPTION =
  "Send a message to this conversation, as yourself. This is how anything you want the person " +
  "here to see is actually delivered while you execute a task — text you merely write in your " +
  "answer is NOT sent anywhere. Call it once per message you want to appear; several calls " +
  "send several messages. If the task turns out to need no message this time, simply do not " +
  "call it — saying nothing is a valid outcome and never an error.";

const NO_TURN = "This call arrived without a conversation to act in, so nothing was done.";

const NOT_A_REPLY_TURN =
  "Replying to a message is only available while a rule triggered by a message is running. " +
  "In this turn your own answer is the message — just write it.";

const NOT_A_SEND_TURN =
  "Sending a standalone message is only available while a timed task is firing. If you are " +
  "acting on a message somebody posted, reply to it instead; in an ordinary turn your own " +
  "answer is the message — just write it.";

function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

/** The binding a hosted tool refuses to work without. */
function requireTurn(meta: unknown): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === "chat" ? turn : null;
}

export interface ChatMcpDeps {
  db: ChatDb;
  /** Wakes the dashboard's thread views, exactly as an inbound message does. */
  onThreadsChanged?: () => void;
}

/** Build this app's MCP server, with every tool bound to the request's turn. */
export function createChatMcpServer(deps: ChatMcpDeps): McpServer {
  const server = new McpServer({ name: "assistant-hub-chat", version: "1.0.0" });

  const deliver = async (
    turn: TurnToolMeta,
    text: string,
    replyToMessageId: number | null,
  ): Promise<{ messageId: number }> => {
    const thread = await getThreadById(deps.db, turn.chatId);
    if (!thread) throw new Error(`thread ${turn.chatId} no longer exists`);
    const stored = await appendMessage(deps.db, {
      threadId: turn.chatId,
      role: "assistant",
      content: text,
      replyToMessageId,
    });
    deps.onThreadsChanged?.();
    return { messageId: stored.id };
  };

  const failure = (text: string, err: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: `The message could not be delivered: ${err instanceof Error ? err.message : String(err)}. Do not claim it was.`,
      },
    ],
    structuredContent: toolDeliveryResult({ ok: false, messageId: null, text }),
    isError: true as const,
  });

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to an earlier message",
      description: REPLY_TO_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("The reply text, exactly as the conversation should read it"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);
      if (turn.deliveryKind !== "reply") return refusal(NOT_A_REPLY_TURN);
      try {
        const sent = await deliver(turn, text, turn.replyToMessageId ?? null);
        return {
          content: [{ type: "text" as const, text: `Reply sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({ ok: true, messageId: sent.messageId, text }),
        };
      } catch (err) {
        return failure(text, err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the conversation",
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("The message text, exactly as the conversation should read it"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);
      if (turn.deliveryKind !== "send") return refusal(NOT_A_SEND_TURN);
      try {
        const sent = await deliver(turn, text, null);
        return {
          content: [{ type: "text" as const, text: `Message sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({ ok: true, messageId: sent.messageId, text }),
        };
      } catch (err) {
        return failure(text, err);
      }
    },
  );

  return server;
}
