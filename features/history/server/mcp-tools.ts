import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { getToolContext } from "@/server/mcp/context";
import { recallChatTopics } from "./recall";
import {
  getChatMessagesByTelegramIds,
  getChatMessagesInRange,
  searchChatMessages,
  type ChatMessageRecord,
} from "./repository";

/**
 * History exposed as MCP tools — deeper-than-the-window lookups the model can
 * request when the recent 24-hour transcript (already injected into every reply)
 * is not enough. The chat is bound per turn via the tool context, so a tool only
 * ever reads the current conversation's messages; the model does not pass (and
 * cannot pick) a chat id.
 *
 * Two kinds of lookup, because they fail in opposite ways. The *literal* ones
 * (search by substring, by date range, by id) are exact but blind: they only find
 * what was worded the way the query words it. The *recall* one searches the daily
 * topic summaries by meaning, so it finds a months-old subject the chat phrased
 * differently — then hands back the message ids to read the originals verbatim.
 *
 * Every message result names its author, and a result that is entirely the bot's
 * own messages says so ({@link SELF_AUTHORED_ONLY_NOTE}). Grounding is ranked by
 * source — what the people here said outranks anything the bot said, and the
 * bot's own output is not a source at all — and that ranking is unusable if a
 * lookup hands back its rows without saying whose they are.
 */

export const HISTORY_SEARCH_TOOL = "history_search";
export const HISTORY_GET_IN_RANGE_TOOL = "history_get_in_range";
export const HISTORY_GET_BY_MESSAGE_IDS_TOOL = "history_get_by_message_ids";
export const HISTORY_RECALL_TOOL = "history_recall_topics";

export const HISTORY_TOOL_NAMES = [
  HISTORY_SEARCH_TOOL,
  HISTORY_GET_IN_RANGE_TOOL,
  HISTORY_GET_BY_MESSAGE_IDS_TOOL,
  HISTORY_RECALL_TOOL,
];

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;
const GET_BY_IDS_MAX = 50;
const RECALL_LIMIT_DEFAULT = 8;
const RECALL_LIMIT_MAX = 20;

/** Structured payload returned alongside the text transcript. */
const historyOutputSchema = {
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      id: z.number().int(),
      replyTo: z.number().int().nullable(),
      role: z.string(),
      content: z.string(),
      at: z.string(),
    }),
  ),
};

/**
 * Who wrote a line, in words rather than as a wire role. `assistant`/`user` name
 * the API's message roles, not the authorship question the model has to answer
 * ("did anyone here actually say this, or is this just me?"), and a result that
 * only says `assistant` reads as ordinary history.
 */
function authorOf(record: ChatMessageRecord): string {
  return record.role === "assistant" ? "you (the bot)" : "a participant";
}

/** One message rendered as an id-anchored transcript line. */
function formatLine(record: ChatMessageRecord): string {
  const reply = record.replyToMessageId != null ? ` [reply to #${record.replyToMessageId}]` : "";
  return `[#${record.telegramMessageId}] [${record.sentAt}] ${authorOf(record)}${reply}: ${record.content}`;
}

/**
 * Verdict appended when every row of a lookup turns out to be the bot's own.
 *
 * A search that returns the bot's own past assertions looks, to the model, like
 * confirmation — it went looking for a claim and found it written down. In
 * production (2026-07-28) that closed the loop on a term the bot had invented
 * itself: it cited its own earlier reply back as the definition. The per-line
 * author labels make the provenance visible; this states the conclusion outright,
 * because "all N hits are mine" is a fact about the result set that no single
 * line carries. Text only, deliberately: the model reads the transcript, and the
 * structured payload already carries `role` per message for anything else.
 */
export const SELF_AUTHORED_ONLY_NOTE =
  "Note: every message above was written by you. Nobody in this chat said any of it, so this " +
  "result confirms nothing — your own past messages are not evidence, and finding your own words " +
  "again is not finding a source. Treat this as not found.";

/** Build the tool result (text transcript + structured messages) from records. */
export function buildResult(records: ChatMessageRecord[]) {
  const messages = records.map((r) => ({
    id: r.telegramMessageId,
    replyTo: r.replyToMessageId,
    role: r.role,
    content: r.content,
    at: r.sentAt,
  }));
  const transcript =
    records.length === 0 ? "(no matching messages)" : records.map(formatLine).join("\n");
  const selfAuthoredOnly =
    records.length > 0 && records.every((record) => record.role === "assistant");
  const text = selfAuthoredOnly ? `${transcript}\n\n${SELF_AUTHORED_ONLY_NOTE}` : transcript;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: true, count: records.length, messages },
  };
}

/** Merge results from several queries into one de-duplicated, ordered list. */
function mergeById(batches: ChatMessageRecord[][]): ChatMessageRecord[] {
  const byId = new Map<number, ChatMessageRecord>();
  for (const batch of batches) {
    for (const record of batch) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Register the history MCP tools on the shared server. */
export function registerHistoryMcpTools(server: McpServer): void {
  server.registerTool(
    HISTORY_SEARCH_TOOL,
    {
      title: "Search conversation history",
      description:
        "Search this conversation's full stored history for messages containing the given " +
        "text (case-insensitive). Use it to recall things said earlier, since only the last " +
        "24 hours of messages are provided automatically. Pass one query string, or several " +
        "to search multiple phrasings at once.",
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe("Text to look for — a single string, or an array of strings"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`Max matches per query (max ${SEARCH_LIMIT_MAX})`),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const { chatId } = getToolContext();
      const queries = Array.isArray(query) ? query : [query];
      const cap = limit ?? SEARCH_LIMIT_DEFAULT;
      const db = getDb();
      const batches = await Promise.all(
        queries.map((q) => searchChatMessages(db, chatId, q, cap)),
      );
      return buildResult(mergeById(batches));
    },
  );

  server.registerTool(
    HISTORY_GET_IN_RANGE_TOOL,
    {
      title: "Get history in a date range",
      description:
        "Return this conversation's messages sent within a date/time range (inclusive), " +
        "oldest first. Provide ISO-8601 datetimes; use it to review what was discussed on a " +
        "particular day or period.",
      inputSchema: {
        from: z.string().min(1).describe("Start of the range, ISO-8601 datetime (inclusive)"),
        to: z.string().min(1).describe("End of the range, ISO-8601 datetime (inclusive)"),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ from, to }) => {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid range: provide ISO-8601 'from' and 'to' datetimes where from <= to.",
            },
          ],
          isError: true,
        };
      }
      const { chatId } = getToolContext();
      const records = await getChatMessagesInRange(getDb(), chatId, fromDate, toDate);
      return buildResult(records);
    },
  );

  server.registerTool(
    HISTORY_GET_BY_MESSAGE_IDS_TOOL,
    {
      title: "Get messages by their ids",
      description:
        "Fetch specific messages from this conversation by their Telegram message ids. Use it " +
        "to read a message referenced as #<id> in the transcript (for example a reply target " +
        "marked [reply to #<id>]) whose content is not shown. Ids not found are omitted from " +
        "the result.",
      inputSchema: {
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(GET_BY_IDS_MAX)
          .describe(`Telegram message ids to fetch (max ${GET_BY_IDS_MAX})`),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ids }) => {
      const { chatId } = getToolContext();
      const records = await getChatMessagesByTelegramIds(getDb(), chatId, ids);
      return buildResult(records);
    },
  );

  server.registerTool(
    HISTORY_RECALL_TOOL,
    {
      title: "Recall past conversation topics",
      description:
        "Recall what this conversation discussed in the past — days, weeks, or months ago. " +
        "Searches short summaries of each past day's topics by meaning as well as wording, so it " +
        "finds a subject even when the question phrases it differently than the chat did. This is " +
        "the right way to answer 'what did we decide about X', 'when did we talk about Y', or any " +
        "question about something older than the recent messages already shown to you. Each result " +
        "gives the date, a summary of the topic, and the message ids it came from — fetch those ids " +
        "to read what was actually said before relying on any detail.",
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "What to recall — a topic, question, name, or fact. Pass several phrasings as an " +
              "array to search them all at once.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RECALL_LIMIT_MAX)
          .default(RECALL_LIMIT_DEFAULT)
          .describe(`Max topics to return per query (max ${RECALL_LIMIT_MAX})`),
      },
      outputSchema: {
        ok: z.boolean(),
        count: z.number().int().nonnegative(),
        topics: z.array(
          z.object({
            date: z.string(),
            content: z.string(),
            message_ids: z.array(z.number().int()),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const { chatId } = getToolContext();
      const queries = Array.isArray(query) ? query : [query];
      const cap = limit ?? RECALL_LIMIT_DEFAULT;
      const matches = await recallChatTopics({ chatId, queries, limit: cap });

      const text =
        matches.length === 0
          ? "(no matching topics — this may not have been discussed, or the day it was discussed " +
            "has not been summarized yet)"
          : matches
              .map(
                (m) =>
                  `[${m.summaryDate}] ${m.content}\n  message_ids: ${m.messageIds.join(", ") || "(none)"}`,
              )
              .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          ok: true,
          count: matches.length,
          topics: matches.map((m) => ({
            date: m.summaryDate,
            content: m.content,
            message_ids: m.messageIds,
          })),
        },
      };
    },
  );
}
