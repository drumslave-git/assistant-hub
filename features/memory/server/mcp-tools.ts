import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getToolContext } from "@/server/mcp/context";

import {
  DURABLE_FACT_KINDS,
  FIRST_PERSON_EVIDENCE_RULE,
  MAX_FACT_LENGTH,
  MIN_FACT_LENGTH,
  NON_DURABLE_FACT_KINDS,
  SELF_CONTAINED_FACT_RULE,
  UNIDENTIFIED_PERSON_RULE,
} from "../prompt";
import type { MemoryMatch } from "../types";
import {
  checkGeneralNoteSubject,
  readMemory,
  resolveMemorySubject,
  saveMemoryNote,
  searchMemory,
} from "./service";

/**
 * The memory MCP tools. Each is self-describing and names no other tool
 * (`tools-self-describe-atomic`): the model chooses between them from their
 * descriptions alone.
 *
 * The current chat and speaker come from the per-turn tool context, never from
 * the model — a tool cannot be talked into writing memory into another
 * conversation. The person a fact is *about* defaults to whoever the bot is
 * talking to (the bound speaker) and is otherwise named by a name the model
 * already sees — never a numeric id, which the model is never given. Resolving
 * that reference against the chat's participants is what decides scope: someone
 * this chat knows gets their own document, and anyone else is shared knowledge.
 * The policy itself lives in the service (`resolveMemorySubject`,
 * `checkGeneralNoteSubject`); these handlers only carry it to the model.
 */

export const MEMORY_SAVE_TOOL = "memory_save";
export const MEMORY_GET_TOOL = "memory_get";
export const MEMORY_SEARCH_TOOL = "memory_search";

export const MEMORY_TOOL_NAMES = [MEMORY_SAVE_TOOL, MEMORY_GET_TOOL, MEMORY_SEARCH_TOOL];

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 20;

const memoryScope = z.enum(["user", "general"]);

const memoryOutputSchema = {
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  memories: z.array(
    z.object({
      scope: z.string(),
      user_id: z.string().nullable(),
      content: z.string(),
    }),
  ),
};

/** Render matches as the model-facing text + structured result. */
function buildResult(matches: MemoryMatch[], emptyText: string) {
  const text =
    matches.length === 0
      ? emptyText
      : matches
          .map((m) => `[${m.scope === "user" ? `user ${m.userId}` : "general"}] ${m.content}`)
          .join("\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      ok: true,
      count: matches.length,
      memories: matches.map((m) => ({
        scope: m.scope,
        user_id: m.userId,
        content: m.content,
      })),
    },
  };
}

/** Register the memory MCP tools on the shared server. */
export function registerMemoryMcpTools(server: McpServer): void {
  server.registerTool(
    MEMORY_SAVE_TOOL,
    {
      title: "Save a durable fact to long-term memory",
      description:
        "Record ONE durable fact so you still know it in future conversations, days or months " +
        "from now. This is the ONLY way anything is remembered: your reply is forgotten once the " +
        "conversation moves on, so a fact you do not save here is lost permanently, and saying " +
        "'I'll remember that' without calling this tool is a false promise.\n" +
        "MUST call, before you reply, whenever the message asks you to remember, note, save, keep " +
        "in mind, or not forget something.\n" +
        "ALSO call, without being asked, the moment someone reveals something lastingly true about " +
        `themselves — ${DURABLE_FACT_KINDS}. Saving proactively is expected of ` +
        "you, not optional: prefer saving a fact that turns out to be minor over losing one that " +
        "mattered.\n" +
        "EXCEPTION — what a person in THIS chat is called (a nickname, alias, 'call me X', or " +
        "'when I say X I mean Y') is never saved here: name recognition does not read memory, so " +
        "a note about a name changes nothing — record the name with the dedicated alias-recording " +
        "tool instead.\n" +
        "Use scope 'user' for a fact about a person this chat knows (this is how you remember " +
        "someone across chats). By default the fact is saved about the person you are talking to " +
        "right now; to save it about someone else in this chat, name them in 'person' by a name " +
        "you already see for them (their first name, @username, or a known nickname) — never a " +
        "numeric id.\n" +
        "Use scope 'general' for knowledge that is about nobody — a definition, a rule, a " +
        "convention, how something works — and ALSO for a fact about a person who is not in this " +
        "chat and so has no memory of their own: name them in 'person', and write their name into " +
        "the fact itself so it still says who it is about. A fact about someone who IS in this " +
        "chat is refused under 'general' — it belongs in their own memory.\n" +
        `Evidence: ${FIRST_PERSON_EVIDENCE_RULE}.\n` +
        `Identity: ${UNIDENTIFIED_PERSON_RULE}.\n` +
        `Do NOT save: ${NON_DURABLE_FACT_KINDS}. Do not re-save something you have already saved.\n` +
        `Save ONE fact per call — make several calls for several facts — and ${SELF_CONTAINED_FACT_RULE}.`,
      inputSchema: {
        scope: memoryScope.describe(
          "'user' for a fact about a specific person, 'general' for shared knowledge",
        ),
        person: z
          .string()
          .optional()
          .describe(
            "Who the fact is about, named by a name you already see for them (first name, @username, " +
              "or known nickname). For scope 'user', omit to save it about the person you are talking " +
              "to now. For scope 'general', name them whenever the fact is about a person, and omit it " +
              "only when the fact is about nobody.",
          ),
        content: z
          .string()
          .min(MIN_FACT_LENGTH)
          .max(MAX_FACT_LENGTH)
          .describe("The durable fact, as one self-contained sentence"),
      },
      outputSchema: {
        ok: z.boolean(),
        scope: z.string(),
        user_id: z.string().nullable(),
        saved: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scope, person, content }) => {
      const { chatId, userId: speakerId } = getToolContext();

      let subjectId: string | null = null;
      if (scope === "user") {
        const subject = await resolveMemorySubject({ person, chatId, speakerId });
        if (!subject.ok) {
          return { content: [{ type: "text" as const, text: subject.error }], isError: true };
        }
        subjectId = subject.userId;
      } else {
        // A general note may be about a person — but only one this chat cannot
        // file under an id of their own.
        const allowed = await checkGeneralNoteSubject({ person, chatId });
        if (!allowed.ok) {
          return { content: [{ type: "text" as const, text: allowed.error }], isError: true };
        }
      }

      const outcome = await saveMemoryNote({ scope, userId: subjectId, content, chatId });
      if (!outcome.ok) {
        return {
          content: [{ type: "text" as const, text: outcome.error }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Saved to long-term memory${subjectId ? ` about user ${subjectId}` : ""}. ` +
              "It is merged into your durable memory overnight and will be there in future " +
              "conversations. Do not save this same fact again.",
          },
        ],
        structuredContent: {
          ok: true,
          scope,
          user_id: outcome.entry.userId,
          saved: true,
        },
      };
    },
  );

  server.registerTool(
    MEMORY_GET_TOOL,
    {
      title: "Read everything you durably know about one person",
      description:
        "Read out every durable fact you know about one person — by default the person you are " +
        "talking to now, or someone else in this chat when you name them in 'person' (by a name " +
        "you already see for them, never a numeric id). Use it when you need the full picture of " +
        "someone rather than a specific answer — for example before saying you do not know " +
        "something durable about them.",
      inputSchema: {
        person: z
          .string()
          .optional()
          .describe(
            "Whose memory to read, named by a name you already see for them (first name, @username, " +
              "or known nickname). Omit to read the person you are talking to now.",
          ),
      },
      outputSchema: memoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ person }) => {
      const { chatId, userId: speakerId } = getToolContext();
      const subject = await resolveMemorySubject({ person, chatId, speakerId });
      if (!subject.ok) {
        return { content: [{ type: "text" as const, text: subject.error }], isError: true };
      }
      const matches = await readMemory({ userId: subject.userId });
      return buildResult(matches, "(nothing durable is stored about this person yet)");
    },
  );

  server.registerTool(
    MEMORY_SEARCH_TOOL,
    {
      title: "Search what you durably know about people",
      description:
        "Search every durable fact you know about people — including people who are not in this " +
        "conversation — by meaning as well as wording, so it finds a fact even when the question " +
        "phrases it differently than it was stored. Use it to recall something durable about " +
        "someone when you do not know who it belongs to, or to check what you already know " +
        "before answering a question about a lasting fact. Each result is tagged with the person " +
        "it belongs to. Note this searches durable memory — what you know about people — not " +
        "what was said in a past conversation.",
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "What to recall — a name, preference, or fact about someone. Pass several phrasings " +
              "as an array to search them all at once.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`Max matches to return per query (max ${SEARCH_LIMIT_MAX})`),
      },
      outputSchema: memoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const queries = Array.isArray(query) ? query : [query];
      const matches = await searchMemory({
        queries,
        limit: limit ?? SEARCH_LIMIT_DEFAULT,
      });
      return buildResult(
        matches,
        "(no matching memory about anyone — this may simply never have been saved)",
      );
    },
  );
}
