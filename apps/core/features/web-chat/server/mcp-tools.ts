import "server-only";

import { toolDeliveryResult } from "@assistant-hub-swarm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { tryGetToolContext, type McpToolContext } from "@/server/mcp/context";
import type { ToolOfferScope } from "@/server/mcp/registry";

import { appendMessage, getThreadById } from "./repository";
import { pingThreads } from "./service";

/**
 * The web chat's delivery tools — what used to be the chat app's own MCP
 * server (Phase 5), as in-process registry tools since the dissolve. A
 * transport's twin lives in the transport; a web thread's tools have nowhere
 * to travel to, so they went back in-process — under the same `chat_`-prefixed
 * names
 * their connection era gave them, so task instructions and traces that name
 * them keep meaning the same call.
 *
 * There is no reaction tool here, and that is the whole answer to "what does
 * a source do about an affordance it lacks": it does not offer the tool.
 *
 * Offering follows the same rules a source connection's delivery tools get
 * (`mcp-tools/server/service.ts`): only on web-chat turns, and each tool only
 * for its own delivery kind — enforced at offer time through the registry's
 * offer predicate, and re-checked here because the filter is what the model
 * *sees*, not the boundary that holds.
 */

export const CHAT_REPLY_TOOL = "chat_reply_to_message";
export const CHAT_SEND_TOOL = "chat_send_message";

export const WEB_CHAT_TOOL_NAMES = [CHAT_REPLY_TOOL, CHAT_SEND_TOOL];

/** Which turns each tool is offered on — the registry's offer predicate. */
export function webChatToolOffered(toolName: string, scope: ToolOfferScope): boolean {
  if (scope.source !== "chat") return false;
  if (toolName === CHAT_REPLY_TOOL) return scope.delivery === "reply";
  if (toolName === CHAT_SEND_TOOL) return scope.delivery === "send";
  return false;
}

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

/** The bound web-chat turn, or null when this is not one. */
function requireChatTurn(): McpToolContext | null {
  const ctx = tryGetToolContext();
  return ctx && ctx.source === "chat" ? ctx : null;
}

async function deliver(
  ctx: McpToolContext,
  text: string,
  replyToSourceMessageId: string | null,
): Promise<{ sourceMessageId: string }> {
  const thread = await getThreadById(ctx.chatId);
  if (!thread) throw new Error(`thread ${ctx.chatId} no longer exists`);
  const stored = await appendMessage({
    threadId: ctx.chatId,
    role: "assistant",
    content: text,
    // The web chat's own rows are keyed by a serial; ids are strings
    // everywhere they cross the turn, and come back here where they belong.
    replyToMessageId: replyToSourceMessageId != null ? Number(replyToSourceMessageId) : null,
  });
  pingThreads();
  return { sourceMessageId: String(stored.id) };
}

function failure(text: string, err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `The message could not be delivered: ${err instanceof Error ? err.message : String(err)}. Do not claim it was.`,
      },
    ],
    structuredContent: toolDeliveryResult({ ok: false, sourceMessageId: null, text }),
    isError: true as const,
  };
}

/** Delivered-or-not, into the turn's own bookkeeping (a fire counts these). */
async function recordDelivery(delivery: {
  ok: boolean;
  sourceMessageId: string | null;
  text: string;
}): Promise<void> {
  await tryGetToolContext()?.onDelivered?.(delivery);
}

export function registerWebChatMcpTools(server: McpServer): void {
  server.registerTool(
    CHAT_REPLY_TOOL,
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
    async ({ text }) => {
      const ctx = requireChatTurn();
      if (!ctx) return refusal(NO_TURN);
      if (ctx.deliveryKind !== "reply") return refusal(NOT_A_REPLY_TURN);
      try {
        const sent = await deliver(ctx, text, ctx.replyToSourceMessageId ?? null);
        await recordDelivery({ ok: true, sourceMessageId: sent.sourceMessageId, text });
        return {
          content: [{ type: "text" as const, text: `Reply sent (id ${sent.sourceMessageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: sent.sourceMessageId,
            text,
          }),
        };
      } catch (err) {
        await recordDelivery({ ok: false, sourceMessageId: null, text });
        return failure(text, err);
      }
    },
  );

  server.registerTool(
    CHAT_SEND_TOOL,
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
    async ({ text }) => {
      const ctx = requireChatTurn();
      if (!ctx) return refusal(NO_TURN);
      if (ctx.deliveryKind !== "send") return refusal(NOT_A_SEND_TURN);
      try {
        const sent = await deliver(ctx, text, null);
        await recordDelivery({ ok: true, sourceMessageId: sent.sourceMessageId, text });
        return {
          content: [{ type: "text" as const, text: `Message sent (id ${sent.sourceMessageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: sent.sourceMessageId,
            text,
          }),
        };
      } catch (err) {
        await recordDelivery({ ok: false, sourceMessageId: null, text });
        return failure(text, err);
      }
    },
  );
}
