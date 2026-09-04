import {
  readTurnMeta,
  toolDeliveryResult,
  type SourceTraceClient,
  type TurnToolMeta,
} from "@assistant-hub-swarm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sendChatMessage, type SendContext } from "./send";
import { tracedTool } from "./trace";
import type { TransportDescriptor } from "./types";

/**
 * The two delivery tools every transport offers, registered onto the caller's
 * `McpServer`.
 *
 * These are not platform actions dressed up — they are the CONTRACT's tools:
 * which one a turn may use is decided by `deliveryKind` on the binding, the
 * reply target is the turn's rather than the model's, and every outcome is
 * reported in `structuredContent` so the core learns a send happened from the
 * result shape and never from a tool's name. Getting any of that subtly wrong
 * per transport is exactly what this package exists to prevent.
 *
 * Reacting is NOT here: which emoji a platform allows, and what else it
 * offers alongside, differ enough that each transport registers its own tool
 * — over `reactToMessage`, which owns the part that does not differ.
 */

const NO_TURN =
  "This tool can only be used inside a turn on this platform, and this call carries no turn " +
  "binding. Nothing was sent.";
const NOT_A_REPLY_TURN =
  "This turn does not answer a message, so there is nothing to reply to. Nothing was sent.";
const NOT_A_SEND_TURN =
  "This turn answers a message; reply to it instead of sending a standalone message. " +
  "Nothing was sent.";

/** How the delivery tools word themselves for one platform. */
export interface DeliveryToolTexts {
  /** How the platform names itself in a tool description ("Discord"). */
  platform: string;
  replyToMessage?: string;
  sendMessage?: string;
}

function defaults(platform: string): Required<Omit<DeliveryToolTexts, "platform">> {
  return {
    replyToMessage:
      `Send your answer to the ${platform} message that opened this turn, attached to it as a ` +
      "reply. Use it once, with the complete answer as the chat should read it — the text is " +
      "delivered verbatim. Long answers are split across messages automatically; do not " +
      "shorten to fit.",
    sendMessage:
      `Send a message into the ${platform} chat this turn belongs to, not attached to anything. ` +
      "Use it once, with the complete text as the chat should read it.",
  };
}

/**
 * The turn a hosted tool is bound to, or null when the call carries none.
 * Exported because a transport's own tools need exactly the same check.
 */
export function turnOf(meta: unknown, source: string): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === source ? turn : null;
}

/** A tool result that says plainly that nothing happened. */
export function toolRefusal(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export interface DeliveryToolDeps {
  descriptor: TransportDescriptor;
  send: SendContext;
  errorText: (err: unknown) => string;
  texts: DeliveryToolTexts;
  /** Records what each call did, on the turn's own correlation. */
  traces?: SourceTraceClient | null;
}

export function registerDeliveryTools(server: McpServer, deps: DeliveryToolDeps): void {
  const { descriptor } = deps;
  const texts = { ...defaults(deps.texts.platform), ...deps.texts };

  const deliveryFailure = (text: string, err: unknown) => ({
    content: [
      {
        type: "text" as const,
        text:
          `${deps.texts.platform} did not accept the message: ${deps.errorText(err)}. ` +
          "Nothing was delivered — do not claim it was.",
      },
    ],
    structuredContent: toolDeliveryResult({ ok: false, sourceMessageId: null, text }),
    isError: true as const,
  });

  const deliver = async (turn: TurnToolMeta, text: string, replyTo: string | null) => {
    const connection = deps.send.connectionFor(turn.assistantId ?? null);
    return sendChatMessage(deps.send, {
      chatId: turn.chatId,
      assistantId: turn.assistantId ?? null,
      text,
      direct: await connection.isDirectChat(turn.chatId).catch(() => false),
      replyToSourceMessageId: replyTo,
      threadId: turn.threadId ?? null,
    });
  };

  const textInput = (what: string) => ({
    text: z
      .string()
      .min(1)
      .max(descriptor.maxMessageLength)
      .describe(`The ${what}, exactly as the chat should read it`),
  });

  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to an earlier message",
      description: texts.replyToMessage,
      inputSchema: textInput("reply text"),
      annotations,
    },
    async ({ text }, extra) => {
      const turn = turnOf(extra?._meta, descriptor.id);
      return tracedTool(
        { traces: deps.traces ?? null, descriptor, turn, action: "reply_to_message", inputSummary: text },
        async (event) => {
          if (!turn) return toolRefusal(NO_TURN);
          if (turn.deliveryKind !== "reply") return toolRefusal(NOT_A_REPLY_TURN);
          try {
            // Which message it lands under is the turn's, never the model's.
            const sent = await deliver(turn, text, turn.replyToSourceMessageId ?? null);
            event({
              message:
                sent.sourceMessageIds.length > 1
                  ? `reply sent as ${sent.sourceMessageIds.length} messages`
                  : "reply sent",
              type: "external_call",
              level: "success",
              data: {
                sourceMessageIds: sent.sourceMessageIds,
                requestedReplyToSourceMessageId: turn.replyToSourceMessageId ?? null,
                replyToSourceMessageId: sent.replyToSourceMessageId,
              },
            });
            return {
              content: [{ type: "text" as const, text: `Reply sent (id ${sent.sourceMessageId}).` }],
              structuredContent: toolDeliveryResult({
                ok: true,
                sourceMessageId: sent.sourceMessageId,
                text,
              }),
            };
          } catch (err) {
            event({
              message: `the platform refused the send: ${deps.errorText(err)}`,
              type: "error",
              level: "error",
            });
            return deliveryFailure(text, err);
          }
        },
      );
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the chat",
      description: texts.sendMessage,
      inputSchema: textInput("message text"),
      annotations,
    },
    async ({ text }, extra) => {
      const turn = turnOf(extra?._meta, descriptor.id);
      return tracedTool(
        { traces: deps.traces ?? null, descriptor, turn, action: "send_message", inputSummary: text },
        async (event) => {
          if (!turn) return toolRefusal(NO_TURN);
          if (turn.deliveryKind !== "send") return toolRefusal(NOT_A_SEND_TURN);
          try {
            // A fire sends standalone: nothing triggered it, so there is
            // nothing to attach to and no target for the model to aim wrong.
            const sent = await deliver(turn, text, null);
            event({
              message:
                sent.sourceMessageIds.length > 1
                  ? `message sent as ${sent.sourceMessageIds.length} messages`
                  : "message sent",
              type: "external_call",
              level: "success",
              data: { sourceMessageIds: sent.sourceMessageIds },
            });
            return {
              content: [
                { type: "text" as const, text: `Message sent (id ${sent.sourceMessageId}).` },
              ],
              structuredContent: toolDeliveryResult({
                ok: true,
                sourceMessageId: sent.sourceMessageId,
                text,
              }),
            };
          } catch (err) {
            event({
              message: `the platform refused the send: ${deps.errorText(err)}`,
              type: "error",
              level: "error",
            });
            return deliveryFailure(text, err);
          }
        },
      );
    },
  );
}
