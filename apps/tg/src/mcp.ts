import { readTurnMeta, type TurnToolMeta } from "@assistant-hub/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BotManager } from "./bot-manager";
import type { TgDb } from "./db";
import {
  reactToMessage,
  TELEGRAM_REACTION_EMOJI,
  toTelegramReactionEmoji,
} from "./reactions";

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

export const TG_MCP_TOOLS = ["set_message_reaction"] as const;

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

/** Refusal shape: the model is told what went wrong, in words it can act on. */
function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, message_id: null, emoji: null },
    isError: true,
  };
}

/** The binding a hosted tool refuses to work without. */
function requireTurn(meta: unknown): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === "tg" ? turn : null;
}

export interface TgMcpDeps {
  db: TgDb;
  manager: Pick<BotManager, "senderFor">;
}

/** Build this app's MCP server, with every tool bound to the request's turn. */
export function createTgMcpServer(deps: TgMcpDeps): McpServer {
  const server = new McpServer({ name: "assistant-hub-tg", version: "1.0.0" });

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
      if (!turn) {
        return refusal(
          "This call arrived without a conversation to act in, so nothing was done.",
        );
      }

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
          db: deps.db,
          sender: deps.manager.senderFor(turn.assistantId ?? null),
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
