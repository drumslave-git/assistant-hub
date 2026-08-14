import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { getChatMessagesByTelegramIds } from "@/features/history/server/repository";
import { TELEGRAM_REACTION_EMOJI, toTelegramReactionEmoji } from "@/lib/telegram";
import { getToolContext, tryGetToolContext } from "@/server/mcp/context";

/**
 * The two ways the bot addresses a *particular message* rather than the chat at
 * large: attaching what it says to that message (`reply_to_message`), and
 * putting a reaction on it (`set_message_reaction`). Both are chat-bound through
 * the tool context and both check the target against this chat's history mirror
 * before acting, so the model can never aim either at another conversation or at
 * an id it invented.
 *
 * `reply_to_message` — how what the bot says is attached. One name, two
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
export const SET_MESSAGE_REACTION_TOOL = "set_message_reaction";

export const BOT_MESSAGING_TOOL_NAMES = [REPLY_TO_MESSAGE_TOOL, SET_MESSAGE_REACTION_TOOL];

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

const SET_MESSAGE_REACTION_DESCRIPTION =
  "Put one of Telegram's reaction emoji on a specific message in this chat — the small emoji " +
  "badge under it, not a message of your own. Give it the #<id> of the message to react to and " +
  "the 'emoji' to show. Use it when someone asks you to like, thumbs-up, heart or otherwise " +
  "react to something, and use it on your own initiative when a short acknowledgement is the " +
  "whole response a message deserves — you agree, you find it funny, you have noted it — " +
  "instead of writing a message that says only that. It is not a substitute for an answer: if " +
  "something was asked of you, react and still answer. Omit 'emoji' to take your reaction back " +
  "off a message. You get one reaction per message, so reacting again replaces the one you had " +
  "there. React only to messages other people sent — never to your own. Only use an id you " +
  "actually saw in this conversation or got back from a lookup — never a guessed number.";

const setMessageReactionOutputSchema = {
  ok: z.boolean(),
  /** The message reacted to, when the call was accepted. */
  message_id: z.number().int().nullable(),
  /** The emoji now showing, or null when the reaction was taken off / refused. */
  emoji: z.string().nullable(),
};

/** Refusal shape for the reaction tool (its own structured fields). */
function reactionRefusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, message_id: null, emoji: null },
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

  server.registerTool(
    SET_MESSAGE_REACTION_TOOL,
    {
      title: "React to a message",
      description: SET_MESSAGE_REACTION_DESCRIPTION,
      inputSchema: {
        message_id: z
          .number()
          .int()
          .positive()
          .describe(
            "The Telegram message id to react to — the number in the #<id> anchor of the " +
              "message you are reacting to.",
          ),
        // Free text carrying the allowed set in its description, rather than a
        // `z.enum` of the 73 values. An enum would be validated *here*, and the
        // local backends this bot usually runs on template tool JSON without
        // enforcing schemas — so an off-list or variation-selector spelling
        // would come back as a raw zod error instead of a refusal written for
        // the model. The handler checks it instead, and accepts the spellings
        // Telegram itself would not (see `toTelegramReactionEmoji`).
        emoji: z
          .string()
          .default("")
          .describe(
            `The reaction emoji, one of: ${TELEGRAM_REACTION_EMOJI.join(" ")} — ` +
              "leave empty to remove your reaction from the message",
          ),
        big: z
          .boolean()
          .default(false)
          .describe("Show the reaction as a big animated effect (use sparingly)"),
      },
      outputSchema: setMessageReactionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, emoji, big }) => {
      const { chatId } = getToolContext();

      const requested = emoji.trim();
      const reaction = requested ? toTelegramReactionEmoji(requested) : null;
      if (requested && !reaction) {
        return reactionRefusal(
          `Telegram has no "${requested}" reaction. Pick one of: ` +
            `${TELEGRAM_REACTION_EMOJI.join(" ")}`,
        );
      }

      const [found] = await getChatMessagesByTelegramIds(getDb(), chatId, [message_id]);
      if (!found) {
        return reactionRefusal(
          `No message #${message_id} in this chat. Do not guess ids — look the message up again ` +
            "and use an id from the result, or answer without reacting.",
        );
      }
      // Reacting to itself is the one target that is never right: a badge the bot
      // put on its own message says nothing to anyone, and Telegram would happily
      // allow it. `assistant` is exactly the bot's own output in the mirror —
      // another bot's message arrives as an ordinary `user` row and stays fair game.
      if (found.role === "assistant") {
        return reactionRefusal(
          `Message #${message_id} is your own — do not react to what you said yourself. ` +
            "React to someone else's message, or say what you mean in your answer.",
        );
      }

      try {
        // Imported lazily, and this is load-bearing: the Telegram edge imports
        // the reply pipeline, which imports the tool registry, which imports
        // this module. At module scope that cycle leaves `BOT_MESSAGING_TOOL_NAMES`
        // undefined while the registrar table is being built — every tool in
        // this file silently loses its owning feature. No other tool module
        // reaches the bot directly; this one must, since a reaction is not a
        // message the pipeline can deliver.
        const { reactToChatMessage } = await import("@/server/telegram/bot-manager");
        await reactToChatMessage(chatId, message_id, reaction, { big });
      } catch (err) {
        // Telegram refuses reactions for reasons this side cannot know in
        // advance — a chat that allows only some emoji, a message too old, the
        // poller not running. Relayed verbatim rather than swallowed: a silent
        // failure would leave the model telling the chat it reacted.
        return reactionRefusal(
          `Telegram did not accept the reaction: ${err instanceof Error ? err.message : String(err)}. ` +
            "Do not claim you reacted.",
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: reaction
              ? `Reacted ${reaction} to message #${message_id}. The chat sees it under that ` +
                "message, so there is no need to also say that you reacted."
              : `Removed your reaction from message #${message_id}.`,
          },
        ],
        structuredContent: { ok: true, message_id, emoji: reaction },
      };
    },
  );
}
