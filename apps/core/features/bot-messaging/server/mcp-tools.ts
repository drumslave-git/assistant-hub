import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TELEGRAM_REACTION_EMOJI, toTelegramReactionEmoji } from "@/lib/telegram";
import { getToolContext, tryGetToolContext } from "@/server/mcp/context";
import { sourceOutbound } from "@/server/turn/source-outbound";

/**
 * `reply_to_message` — how a **message-triggered task** says something back, and
 * `set_message_reaction` — how the bot puts a reaction badge on a message. Both
 * are chat-bound through the tool context, so neither can act on another
 * conversation.
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
export const SET_MESSAGE_REACTION_TOOL = "set_message_reaction";

export const BOT_MESSAGING_TOOL_NAMES = [REPLY_TO_MESSAGE_TOOL, SET_MESSAGE_REACTION_TOOL];

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
      const ctx = getToolContext();
      const { chatId } = ctx;

      const requested = emoji.trim();
      const reaction = requested ? toTelegramReactionEmoji(requested) : null;
      if (requested && !reaction) {
        return reactionRefusal(
          `Telegram has no "${requested}" reaction. Pick one of: ` +
            `${TELEGRAM_REACTION_EMOJI.join(" ")}`,
        );
      }

      const noMessageRefusal = () =>
        reactionRefusal(
          `No message #${message_id} in this chat. Do not guess ids — look the message up again ` +
            "and use an id from the result, or answer without reacting.",
        );
      // Reacting to itself is the one target that is never right: a badge the bot
      // put on its own message says nothing to anyone, and Telegram would happily
      // allow it. `assistant` is exactly the bot's own output in the mirror —
      // another bot's message arrives as an ordinary `user` row and stays fair game.
      const ownMessageRefusal = () =>
        reactionRefusal(
          `Message #${message_id} is your own — do not react to what you said yourself. ` +
            "React to someone else's message, or say what you mean in your answer.",
        );
      // Telegram refuses reactions for reasons this side cannot know in
      // advance — a chat that allows only some emoji, a message too old, the
      // poller not running. Relayed verbatim rather than swallowed: a silent
      // failure would leave the model telling the chat it reacted.
      const telegramRefusal = (err: unknown) =>
        reactionRefusal(
          `Telegram did not accept the reaction: ${err instanceof Error ? err.message : String(err)}. ` +
            "Do not claim you reacted.",
        );

      // The source owns the mirror and the platform call: one request checks
      // the target (`not_found` / `own_message`), reacts, and records. A
      // reply turn carries the binding on its tool context; a turn without
      // one (a task fire) reaches the source's API directly.
      const react =
        ctx.reactToMessage ??
        (() => {
          // Raw telegram chat id: reactions are a telegram affordance, and
          // this fallback path (a task fire with no turn binding) has no ref
          // to resolve a source from until the tool contexts carry one.
          const port = sourceOutbound("tg");
          if (!port) return null;
          return (input: { messageId: number; emoji: string | null; big?: boolean }) =>
            port.setReaction(chatId, input.messageId, input.emoji, { big: input.big });
        })();
      if (!react) {
        return reactionRefusal(
          "Reactions are unavailable: the telegram service is not configured. Answer without " +
            "reacting, and do not claim you reacted.",
        );
      }
      let outcome: Awaited<ReturnType<typeof react>>;
      try {
        outcome = await react({ messageId: message_id, emoji: reaction, big });
      } catch (err) {
        return telegramRefusal(err);
      }
      if (outcome.status === "not_found") return noMessageRefusal();
      if (outcome.status === "own_message") return ownMessageRefusal();
      // Whether the bot will *remember* reacting: the source's mirror renders
      // it on the target line (`[you reacted: 👍]`); without that record the
      // very next turn denied having set it (operator report, 2026-08-15).
      // The reaction IS on the message either way — a failed record must not
      // read as a Telegram refusal, only as the memory of it missing.
      const note = outcome.recorded
        ? ""
        : " (Warning: the reaction could not be recorded in your history — later turns may not remember it.)";
      return {
        content: [
          {
            type: "text" as const,
            text:
              (reaction
                ? `Reacted ${reaction} to message #${message_id}. The chat sees it under that ` +
                  "message, so there is no need to also say that you reacted."
                : `Removed your reaction from message #${message_id}.`) + note,
          },
        ],
        structuredContent: { ok: true, message_id, emoji: reaction },
      };
    },
  );
}
