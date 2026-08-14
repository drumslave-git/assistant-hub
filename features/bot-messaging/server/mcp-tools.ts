import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { getChatMessagesByTelegramIds } from "@/features/history/server/repository";
import { tryGetToolContext } from "@/server/mcp/context";

/**
 * How what the bot says is *attached*, exposed as an MCP tool. One name, two
 * execution contexts, one user-facing concept — "what I am saying is about that
 * particular message":
 *
 *  - **Answering someone** (the reply pipeline): the turn already produces
 *    exactly one reply, so the tool moves that reply's target instead of
 *    sending anything. A tool that sent its own message here would produce
 *    two, the second left saying "here it is" about nothing.
 *  - **Executing a task** (a timed fire, marked by the context's `deliver`
 *    binding): the turn's own text is never delivered, so here the tool *is*
 *    the delivery — it sends the given text as a Telegram reply to the target
 *    message (its sibling `send_message`, offered only in fires, sends
 *    standalone messages).
 *
 * The id is checked against this chat's mirror before it is accepted in either
 * mode. A wrong id is a live failure, not a silent one: Telegram refuses
 * `reply_parameters` pointing at a message it cannot find.
 */

export const REPLY_TO_MESSAGE_TOOL = "reply_to_message";

export const BOT_MESSAGING_TOOL_NAMES = [REPLY_TO_MESSAGE_TOOL];

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Attach what you are saying to one specific earlier message in this chat, as a Telegram " +
  "reply that quotes it and taps through to it. Give it the #<id> of that message. Use it " +
  "whenever your answer is ABOUT one particular earlier message — someone asked you to find a " +
  "photo, a link, or something that was said, and you found it; or a task has you acting on a " +
  "specific message. Only use an id you actually saw in this conversation or got back from a " +
  "lookup — never a guessed or edited number. " +
  "When you are ANSWERING someone, it changes where your reply lands, nothing else: write your " +
  "reply as normal, leave 'text' empty, and call this once — a later call replaces the earlier " +
  "target. When you are EXECUTING A TASK (nobody messaged you), nothing you merely write is " +
  "sent anywhere, so pass the message to deliver in 'text' — this call is what sends it.";

const replyToMessageOutputSchema = {
  ok: z.boolean(),
  /** The message the reply will be attached to, when one was accepted. */
  message_id: z.number().int().nullable(),
};

/** Refusal text shared by every way the target can be unusable. */
function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, message_id: null },
    isError: true,
  };
}

/** Register the bot-messaging MCP tools on the shared server. */
export function registerBotMessagingMcpTools(server: McpServer): void {
  server.registerTool(
    REPLY_TO_MESSAGE_TOOL,
    {
      title: "Reply to an earlier message",
      description: REPLY_TO_MESSAGE_DESCRIPTION,
      inputSchema: {
        message_id: z
          .number()
          .int()
          .positive()
          .describe(
            "The Telegram message id to attach your reply to — the number in the #<id> anchor " +
              "of the message you are pointing at.",
          ),
        text: z
          .string()
          .default("")
          .describe(
            "Executing a task: the message text to deliver as the reply (required there — " +
              "only this call sends it). Answering someone: leave empty — your own reply is " +
              "the message being redirected.",
          ),
      },
      outputSchema: replyToMessageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, text }) => {
      const context = tryGetToolContext();
      if (!context || (!context.setReplyTarget && !context.deliver)) {
        // No sink bound → this turn sends no reply anyone can aim. Say so
        // plainly rather than accepting the call and having the model tell the
        // chat it pointed at something.
        return refusal(
          "There is no reply to attach in this context. Answer normally and do not say you " +
            "pointed at a message.",
        );
      }

      const [found] = await getChatMessagesByTelegramIds(getDb(), context.chatId, [message_id]);
      if (!found) {
        return refusal(
          `No message #${message_id} in this chat. Do not guess ids — look the message up again ` +
            "and use an id from the result, or answer without pointing at one.",
        );
      }

      // A task fire: the tool IS the delivery. `deliver` wins over a (never
      // co-bound) retarget sink, and an empty text is a usable error rather than
      // an empty message in the chat.
      if (context.deliver) {
        if (!text.trim()) {
          return refusal(
            "Pass the message to deliver in 'text' — while executing a task, only this call " +
              "sends anything.",
          );
        }
        const { messageId } = await context.deliver(text, { replyToMessageId: message_id });
        return {
          content: [
            {
              type: "text" as const,
              text: `Reply sent (id ${messageId}) to message #${message_id}.`,
            },
          ],
          structuredContent: { ok: true, message_id },
        };
      }

      context.setReplyTarget!(message_id);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Your reply will be attached to message #${message_id}. Write it normally — the ` +
              "chat sees it as a reply to that message, so there is no need to quote or " +
              "describe it.",
          },
        ],
        structuredContent: { ok: true, message_id },
      };
    },
  );
}
