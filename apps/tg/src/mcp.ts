import {
  readTurnMeta,
  toolDeliveryResult,
  type TurnToolMeta,
} from "@assistant-hub-swarm/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BotManager } from "./bot-manager";
import type { AssistantConnection } from "./connections";
import {
  reactToMessage,
  TELEGRAM_REACTION_EMOJI,
  toTelegramReactionEmoji,
} from "./reactions";
import { sendChatMessage } from "./send";
import { telegramId } from "./telegram";
import type { UpdatePublisher } from "./updates";

/**
 * This app's own MCP server (PLAN.md: "it exposes an MCP server for its
 * outbound actions"). The core discovers it as a managed, tg-scoped tool
 * connection, so a Telegram turn is offered these tools and a web-chat turn
 * never sees them.
 *
 * Every tool is bound to a turn the same way: the core attaches the turn's
 * chat, assistant and speaker as MCP `_meta`, never as arguments. A model can
 * therefore choose WHAT to do and never WHERE — the chat is a fact of the
 * turn, not a parameter it could aim somewhere else.
 */

export const TG_MCP_TOOLS = [
  "reply_to_message",
  "send_message",
  "set_message_reaction",
] as const;

/** Telegram's own per-message cap. */
const MAX_MESSAGE_LENGTH = 4000;

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Reply to the message that triggered this rule. Text you merely write in your answer is NOT " +
  "sent anywhere — this call is what delivers it, as a Telegram reply attached to that message, " +
  "so the chat sees what you are responding to and there is no need to quote or describe it. " +
  "Call it once per message you want to appear; several calls send several replies. If the rule " +
  "turns out to require nothing this time, simply do not call it — saying nothing is a valid " +
  "outcome and never an error.";

const SEND_MESSAGE_DESCRIPTION =
  "Send a message to this chat, as yourself. This is how anything you want the people " +
  "here to see is actually delivered while you execute a task — text you merely write " +
  "in your answer is NOT sent anywhere. Call it once per message you want to appear; " +
  "several calls send several messages. If the task turns out to need no message this " +
  "time (nothing to report, condition not met), simply do not call it — saying nothing " +
  "is a valid outcome and never an error.";

const NOT_A_REPLY_TURN =
  "Replying to a message is only available while a rule triggered by a message is running. " +
  "In this turn your own answer is the message — just write it.";

const NOT_A_SEND_TURN =
  "Sending a standalone message is only available while a timed task is firing. If you are " +
  "acting on a message somebody posted, reply to it instead; in an ordinary turn your own " +
  "answer is the message — just write it.";

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

const NO_TURN = "This call arrived without a conversation to act in, so nothing was done.";

/** Refusal shape: the model is told what went wrong, in words it can act on. */
function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, message_id: null, emoji: null },
    isError: true,
  };
}

/**
 * A send Telegram refused. Reported as a delivery that did NOT happen rather
 * than as a bare error: the turn's bookkeeping counts attempts that failed,
 * and the model must not be left thinking its words reached anyone.
 */
function deliveryFailure(text: string, err: unknown) {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text" as const,
        text: `Telegram did not accept the message: ${reason}. Nothing was delivered — do not claim it was.`,
      },
    ],
    structuredContent: toolDeliveryResult({ ok: false, sourceMessageId: null, text }),
    isError: true as const,
  };
}

/** The binding a hosted tool refuses to work without. */
function requireTurn(meta: unknown): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === "tg" ? turn : null;
}

export interface TgMcpDeps {
  manager: Pick<BotManager, "senderFor">;
  /** The transport-update producer (delivered + bot-reaction events). */
  updates: UpdatePublisher;
  /** The connections running right now (the delivered event's roster). */
  running: () => AssistantConnection[];
}

/** Build this app's MCP server, with every tool bound to the request's turn. */
export function createTgMcpServer(deps: TgMcpDeps): McpServer {
  const server = new McpServer({ name: "assistant-hub-tg", version: "1.0.0" });

  /**
   * The two delivery tools. Which one a turn may use is a fact about the turn,
   * not a choice for the model (user decision, 2026-08-14): a rule triggered
   * by a message answers that message, a timed fire speaks unprompted, and an
   * ordinary reply turn delivers its own text and is offered neither. The core
   * withholds the tool that does not match; this checks the turn as well, so
   * a call that arrives anyway cannot smuggle a send into the wrong turn.
   */
  const deliver = (turn: TurnToolMeta, text: string, replyToSourceMessageId: string | null) =>
    sendChatMessage(
      {
        sender: deps.manager.senderFor(turn.assistantId ?? null),
        publisher: deps.updates,
        running: deps.running,
      },
      {
        chatId: turn.chatId,
        assistantId: turn.assistantId ?? null,
        text,
        replyToMessageId: telegramId(replyToSourceMessageId),
        threadId: telegramId(turn.threadId),
      },
    );

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
          .describe("The reply text, exactly as the chat should read it"),
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
        // Which message it lands under is the turn's, never the model's: it
        // replies to the message that opened the turn or to nothing at all.
        const sent = await deliver(turn, text, turn.replyToSourceMessageId ?? null);
        return {
          content: [{ type: "text" as const, text: `Reply sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: String(sent.messageId),
            text,
          }),
        };
      } catch (err) {
        return deliveryFailure(text, err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the chat",
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("The message text, exactly as the chat should read it"),
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
        // A fire sends standalone: nothing triggered it, so there is nothing
        // to attach to and no target for the model to aim wrong.
        const sent = await deliver(turn, text, null);
        return {
          content: [{ type: "text" as const, text: `Message sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: String(sent.messageId),
            text,
          }),
        };
      } catch (err) {
        return deliveryFailure(text, err);
      }
    },
  );

  server.registerTool(
    "set_message_reaction",
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
        // `z.enum` of the 73 values. An enum would be validated by the schema
        // layer, and the local backends this bot usually runs on template tool
        // JSON without enforcing schemas — so an off-list or
        // variation-selector spelling would come back as a raw validation
        // error instead of a refusal written for the model. The handler checks
        // it instead, and accepts spellings Telegram itself would not.
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
      outputSchema: {
        ok: z.boolean(),
        message_id: z.number().int().nullable(),
        emoji: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, emoji, big }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);

      const requested = emoji.trim();
      const reaction = requested ? toTelegramReactionEmoji(requested) : null;
      if (requested && !reaction) {
        return refusal(
          `Telegram has no "${requested}" reaction. Pick one of: ` +
            `${TELEGRAM_REACTION_EMOJI.join(" ")}`,
        );
      }

      let outcome;
      try {
        outcome = await reactToMessage({
          sender: deps.manager.senderFor(turn.assistantId ?? null),
          updates: deps.updates,
          chatId: turn.chatId,
          messageId: message_id,
          emoji: reaction,
          big,
          assistantId: turn.assistantId ?? null,
        });
      } catch (err) {
        // Telegram refused for a reason only it knows (a chat-restricted
        // emoji, a message too old, no running connection) — relayed
        // verbatim so the model does not claim it reacted.
        return refusal(
          `Telegram did not accept the reaction: ${err instanceof Error ? err.message : String(err)}. ` +
            "Do not claim you reacted.",
        );
      }

      if (outcome.status === "not_found") {
        return refusal(
          `No message #${message_id} in this chat. Do not guess ids — look the message up again ` +
            "and use an id from the result, or answer without reacting.",
        );
      }
      // Reacting to itself is the one target that is never right: a badge the
      // bot put on its own message says nothing to anyone, and Telegram would
      // happily allow it.
      if (outcome.status === "own_message") {
        return refusal(
          `Message #${message_id} is your own — do not react to what you said yourself. ` +
            "React to someone else's message, or say what you mean in your answer.",
        );
      }

      // Whether the bot will *remember* reacting: the mirror renders it on the
      // target line (`[you reacted: 👍]`); without that record the very next
      // turn denied having set it (operator report, 2026-08-15). The reaction
      // IS on the message either way — a failed record must not read as a
      // Telegram refusal, only as the memory of it missing.
      const note = outcome.recorded
        ? ""
        : " (Warning: the reaction could not be recorded in your history — later turns may not remember it.)";
      const text =
        (reaction
          ? `Reacted ${reaction} to message #${message_id}. The chat sees it under that ` +
            "message, so there is no need to also say that you reacted."
          : `Removed your reaction from message #${message_id}.`) + note;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { ok: true, message_id, emoji: reaction },
      };
    },
  );

  return server;
}
