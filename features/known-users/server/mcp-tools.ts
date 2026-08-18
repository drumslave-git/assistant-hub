import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getToolContext, toolContextTrigger } from "@/server/mcp/context";
import { formatKnownUserLabel } from "../format";
import { addAliasByReference, type AddAliasByReferenceResult } from "./service";

/**
 * Known-users exposed as MCP tools. `update_user_aliases` lets the model record a
 * nickname it observes for a participant ("people call Alice 'Ali'") so the bot
 * recognizes that name later. Chat-scoped via the tool context — the model
 * identifies the person by a name it already sees (never a numeric id), and only
 * people who have messaged in the current chat can be updated.
 */

export const UPDATE_USER_ALIASES_TOOL = "update_user_aliases";

export const KNOWN_USERS_TOOL_NAMES = [UPDATE_USER_ALIASES_TOOL];

/** Turn a service result into the tool's text (and error flag). */
function resultMessage(reference: string, result: AddAliasByReferenceResult): {
  text: string;
  isError: boolean;
} {
  switch (result.status) {
    case "updated": {
      const label = formatKnownUserLabel(result.user);
      const list = result.added.map((a) => `"${a}"`).join(", ");
      return { text: `Noted ${list} as an alias for ${label}.`, isError: false };
    }
    case "noop":
      return {
        text: `${formatKnownUserLabel(result.user)} is already known by that name — nothing to add.`,
        isError: false,
      };
    case "not_found":
      return {
        text: `No one in this chat is known as "${reference}". Only people who have messaged here can be updated.`,
        isError: true,
      };
    case "ambiguous":
      return {
        text: `"${reference}" matches ${result.count} people in this chat — be more specific (e.g. use their @username).`,
        isError: true,
      };
    case "invalid":
      return { text: result.reason, isError: true };
  }
}

/** Register the known-users MCP tools on the shared server. */
export function registerKnownUsersMcpTools(server: McpServer): void {
  server.registerTool(
    UPDATE_USER_ALIASES_TOOL,
    {
      title: "Remember a user's other name",
      description:
        "Record an additional name or nickname for a person in this chat, so the bot recognizes " +
        "them by it later. Call this whenever someone is referred to by — or tells you — a name " +
        "other than the one shown for them (e.g. a nickname, or a shortened first name); actually " +
        "record it, do not merely say you did. Identify the person by a name you already see for " +
        "them (their first name, @username, or a known nickname).",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("A name you already see for this person (first name, @username, or known nickname)"),
        aliases: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe("The additional name(s)/nickname(s) to remember — one string, or an array"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, aliases }) => {
      const ctx = getToolContext();
      const list = Array.isArray(aliases) ? aliases : [aliases];
      const result = await addAliasByReference(
        { chatId: ctx.chatId, reference: name, aliases: list },
        toolContextTrigger(ctx),
      );
      const { text, isError } = resultMessage(name, result);
      return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
    },
  );
}
