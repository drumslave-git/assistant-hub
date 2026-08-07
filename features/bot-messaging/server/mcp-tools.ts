import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { getChatMessagesByTelegramIds } from "@/features/history/server/repository";
import { tryGetToolContext } from "@/server/mcp/context";

/**
 * How the bot's reply is *delivered*, exposed as an MCP tool.
 *
 * A reply normally lands under the message that prompted it, which is right
 * almost always. It is wrong in one recurring case: somebody asks the bot to find
 * an earlier message ("where's that photo of the front door?"). Answering under
 * the question leaves the person to scroll for the thing they asked about, while
 * a Telegram reply aimed at the found message *is* the answer — it quotes it and
 * taps straight through to it.
 *
 * So this tool moves the turn's reply target. It does not send anything: the turn
 * still produces exactly one message, written the way the model was going to write
 * it, just pointed somewhere else. That is deliberate — a tool that sent its own
 * message would produce two, and the second (the turn's real reply) would be left
 * saying "here it is" about nothing.
 *
 * The id is checked against this chat's mirror before it is accepted. A wrong id
 * is a live failure, not a silent one: Telegram refuses `reply_parameters`
 * pointing at a message it cannot find, which would cost the whole reply.
 */

export const REPLY_TO_MESSAGE_TOOL = "reply_to_message";

export const BOT_MESSAGING_TOOL_NAMES = [REPLY_TO_MESSAGE_TOOL];

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Send this turn's reply as a Telegram reply to an earlier message in this chat, instead of " +
  "to the message you are answering. Give it the #<id> of that earlier message. " +
  "Use it whenever your answer is ABOUT one particular earlier message — someone asked you to " +
  "find a photo, a link, or something that was said, and you found it. Pointing at it is what " +
  "makes the answer usable: the chat sees your reply attached to that message and can tap " +
  "through to it. " +
  "Only use an id you actually saw in this conversation or got back from a lookup — never a " +
  "guessed or edited number. " +
  "It changes where your reply lands, nothing else: write your reply as normal (\"here it " +
  "is\"), do not describe the message you are pointing at as though you were quoting it, and " +
  "call this once — a later call replaces the earlier target.";

const replyToMessageOutputSchema = {
  ok: z.boolean(),
  /** The message the reply will be attached to, when one was accepted. */
  message_id: z.number().int().nullable(),
};

/** Refusal text shared by both ways the target can be unusable. */
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
      },
      outputSchema: replyToMessageOutputSchema,
      annotations: {
        // Nothing is read or written: it only redirects a message this turn was
        // going to send anyway.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id }) => {
      const context = tryGetToolContext();
      const setReplyTarget = context?.setReplyTarget;
      // No sink bound → this turn sends no reply anyone can aim (e.g. a
      // scheduled-task fire). Say so plainly rather than accepting the call and
      // having the model tell the chat it pointed at something.
      if (!context || !setReplyTarget) {
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

      setReplyTarget(message_id);
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
