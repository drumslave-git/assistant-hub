import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { resolveChatUserByReference } from "@/features/known-users/server/service";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { getMediaSuffixesForMessages } from "@/features/vision/server/service";
import { MEDIA_KINDS, type MediaKind } from "@/features/vision/types";
import { embedOne } from "@/server/llm/embeddings";
import { getToolContext } from "@/server/mcp/context";
import { recallChatTopics } from "./recall";
import {
  getChatMessagesByTelegramIds,
  getChatMessagesInRange,
  type ChatMessageRecord,
} from "./repository";
import {
  searchChatMessagesHybrid,
  type MessageSearchMatch,
} from "./search-repository";

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
      author: z.string(),
    }),
  ),
};

/**
 * Who wrote a line, in words rather than as a wire role. `assistant`/`user` name
 * the API's message roles, not the authorship question the model has to answer
 * ("did anyone here actually say this, or is this just me?"), and a result that
 * only says `assistant` reads as ordinary history.
 *
 * `labels` names the human when the caller resolved one. Without it a participant
 * stays anonymous — the historical default, and still the right answer for the
 * lookups whose job is only to dereference an id. A search that can be *filtered*
 * by person must name people, though: "find the photo of Bea's door" is
 * unanswerable if every hit reads `a participant`.
 */
function authorOf(record: ChatMessageRecord, labels?: Map<string, string>): string {
  if (record.role === "assistant") return "you (the bot)";
  const label = record.userId ? labels?.get(record.userId) : undefined;
  return label ?? "a participant";
}

/** One message rendered as an id-anchored transcript line. */
function formatLine(
  record: ChatMessageRecord,
  extras?: { labels?: Map<string, string>; mediaSuffixes?: Map<number, string> },
): string {
  const reply = record.replyToMessageId != null ? ` [reply to #${record.replyToMessageId}]` : "";
  const suffix = extras?.mediaSuffixes?.get(record.telegramMessageId) ?? "";
  const author = authorOf(record, extras?.labels);
  return `[#${record.telegramMessageId}] [${record.sentAt}] ${author}${reply}: ${record.content}${suffix}`;
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
export function buildResult(
  records: ChatMessageRecord[],
  extras?: { labels?: Map<string, string>; mediaSuffixes?: Map<number, string> },
) {
  const messages = records.map((r) => ({
    id: r.telegramMessageId,
    replyTo: r.replyToMessageId,
    role: r.role,
    content: `${r.content}${extras?.mediaSuffixes?.get(r.telegramMessageId) ?? ""}`,
    at: r.sentAt,
    author: authorOf(r, extras?.labels),
  }));
  const transcript =
    records.length === 0
      ? "(no matching messages)"
      : records.map((record) => formatLine(record, extras)).join("\n");
  const selfAuthoredOnly =
    records.length > 0 && records.every((record) => record.role === "assistant");
  const text = selfAuthoredOnly ? `${transcript}\n\n${SELF_AUTHORED_ONLY_NOTE}` : transcript;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: true, count: records.length, messages },
  };
}

/**
 * Merge the hits of several queries, keeping each message's best score — a
 * message that ranks under two phrasings should not be penalized for it — then
 * return the top `limit` in chronological order.
 *
 * Ranked while merging, chronological when rendered: relevance decides *which*
 * messages come back, but a transcript that jumps around in time is hard to read
 * and its `[reply to #…]` anchors stop lining up with anything above them.
 */
export function mergeMatches(
  batches: MessageSearchMatch[][],
  limit: number,
): MessageSearchMatch[] {
  const best = new Map<number, MessageSearchMatch>();
  for (const batch of batches) {
    for (const match of batch) {
      const existing = best.get(match.id);
      if (!existing || match.score > existing.score) best.set(match.id, match);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.id - b.id);
}

/** Resolve the speaker labels for a set of hits, so each line names its author. */
async function resolveLabels(records: ChatMessageRecord[]): Promise<Map<string, string>> {
  const userIds = [...new Set(records.map((r) => r.userId).filter((id): id is string => !!id))];
  if (userIds.length === 0) return new Map();
  const users = await getKnownUsersByIds(getDb(), userIds);
  return new Map(users.map((user) => [user.userId, formatKnownUserLabel(user)]));
}

/**
 * Turn the model's `author` reference into the ids to filter by, or an error
 * message to hand back instead of searching.
 *
 * A miss must not silently widen the search. "Find Bea's photo" answered with
 * everyone's photos is worse than an error: the model has no way to tell that the
 * filter was dropped, and the first plausible hit becomes Bea's photo in the
 * reply.
 */
async function resolveAuthorFilter(
  chatId: string,
  author: string,
): Promise<{ ok: true; userIds: string[] } | { ok: false; error: string }> {
  const resolved = await resolveChatUserByReference(chatId, author);
  if (resolved.status === "matched") return { ok: true, userIds: [resolved.user.userId] };
  if (resolved.status === "ambiguous") {
    return {
      ok: false,
      error:
        `"${author}" matches ${resolved.count} people in this chat — search again with a more ` +
        "specific name (for example their @username), or drop the author filter.",
    };
  }
  return {
    ok: false,
    error:
      `Nobody in this chat goes by "${author}", so there are no messages of theirs to search. ` +
      "Check the name against the conversation, or search without the author filter.",
  };
}

/**
 * What the search tool tells the model about itself.
 *
 * Written to fix one specific blind spot: a picture is not its caption. Most
 * photos arrive with no text at all, and a model that thinks of search as "look
 * for these words in what people typed" will not try to find one — it will say it
 * cannot see old images. So the description leads with the fact that pictures,
 * clips and voice notes are searchable by their *content*, and says plainly that
 * the query does not have to be anyone's wording.
 */
const HISTORY_SEARCH_DESCRIPTION =
  "Search this whole conversation's stored history — every message ever sent here, not just " +
  "the recent ones you are shown. " +
  "Searches by meaning as well as by wording, so describe what you are looking for in plain " +
  "words; it does not have to match how anyone phrased it, or even be the same language. " +
  "Photos, videos, GIFs, stickers and voice messages are searched by what is IN them: a " +
  "picture of a door is found by searching for a door, even when it was posted with no caption " +
  "at all. This is how to find a specific image, clip or recording somebody sent earlier. " +
  "Narrow by person with 'author' and to pictures/clips with 'media_kinds' when the request " +
  "names one (\"the photo Bea sent\", \"that video from last week\"). " +
  "Each result is anchored as #<id> — that id is how a specific message is referred to " +
  "afterwards, so keep it if the answer is about one particular message.";

/** Register the history MCP tools on the shared server. */
export function registerHistoryMcpTools(server: McpServer): void {
  server.registerTool(
    HISTORY_SEARCH_TOOL,
    {
      title: "Search conversation history",
      description: HISTORY_SEARCH_DESCRIPTION,
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "What to look for — a single string, or an array of phrasings searched at once. " +
              "Describe the thing in plain words; it does not have to be the wording anyone used.",
          ),
        author: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Only messages sent by this person — a first name, @username, or nickname used in " +
              "this chat. Omit to search everyone's messages.",
          ),
        media_kinds: z
          .array(z.enum(MEDIA_KINDS))
          .min(1)
          .optional()
          .describe(
            "Only messages carrying media of these kinds. Use it when the thing being looked " +
              "for is a picture or a clip rather than something written. Omit for any message.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`Max matches to return (max ${SEARCH_LIMIT_MAX})`),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, author, media_kinds, limit }) => {
      const { chatId } = getToolContext();
      const queries = Array.isArray(query) ? query : [query];
      const cap = limit ?? SEARCH_LIMIT_DEFAULT;
      const db = getDb();

      let authorUserIds: string[] | undefined;
      if (author) {
        const resolved = await resolveAuthorFilter(chatId, author);
        if (!resolved.ok) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            isError: true,
          };
        }
        authorUserIds = resolved.userIds;
      }

      // Embeddings are optional. Without a configured model the search runs on
      // its lexical halves alone — worse recall, but it still works, which beats
      // telling the model "unavailable" and having it claim it cannot look.
      const embedding = await getEmbeddingRuntime().catch(() => null);
      const filters = {
        ...(authorUserIds ? { authorUserIds } : {}),
        ...(media_kinds ? { mediaKinds: media_kinds as MediaKind[] } : {}),
      };

      const batches = await Promise.all(
        queries.map(async (q) => {
          const vector = embedding ? await embedOne(embedding, q).catch(() => null) : null;
          return searchChatMessagesHybrid(db, {
            chatId,
            queryText: q,
            queryVector: vector,
            limit: cap,
            filters,
          });
        }),
      );

      const matches = mergeMatches(batches, cap);
      const [labels, mediaSuffixes] = await Promise.all([
        resolveLabels(matches),
        getMediaSuffixesForMessages(
          chatId,
          matches.map((m) => m.telegramMessageId),
          db,
        ),
      ]);
      return buildResult(matches, { labels, mediaSuffixes });
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
