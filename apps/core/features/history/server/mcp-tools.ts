import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scopedRef, type SourceId } from "@assistant-hub-swarm/contracts";
import { z } from "zod";

import { resolveChatUserByReference } from "@/features/known-users/server/service";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { renderMediaSuffix, type MediaAnnotation } from "@/features/vision/format";
import { MEDIA_KINDS, type MediaKind } from "@/features/vision/types";
import { embedOne } from "@/server/llm/embeddings";
import { getToolContext } from "@/server/mcp/context";
import {
  requireSourceContent,
  type SourceMessageMatch,
} from "@/server/source/content";
import { recallChatTopics } from "./recall";
import type { ChatMessageRecord } from "./repository";
import { resolveSpeakerLabels } from "./service";

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

/**
 * Search results are a *pointer list*, not a reading list — hence a small default
 * and a modest ceiling.
 *
 * Production, 2026-08-07: one search returned 50 hits carrying their full vision
 * descriptions — 41 KB, ~11.8k tokens, taking the reply prompt to 38.8k. The
 * model then answered by pasting one raw result line into the chat. Ten anchored
 * snippets are enough to identify the right message; the full text of a specific
 * one is a separate, deliberate read.
 */
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;

/**
 * How much of each hit the model reads. A vision description runs 600–1500
 * characters — enough to identify a photo ten times over, and enough that fifty
 * of them bury the conversation they were meant to serve. Only the model-facing
 * text is cut; the structured payload (trace-only) keeps every hit in full.
 */
const SNIPPET_CHARS = 220;
const GET_BY_IDS_MAX = 50;
const RECALL_LIMIT_DEFAULT = 8;
const RECALL_LIMIT_MAX = 20;

/** Structured payload returned alongside the text transcript. */
const historyOutputSchema = {
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      id: z.string(),
      replyTo: z.string().nullable(),
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

/** Cut a hit's body to a snippet, marking the cut so nothing reads as complete. */
function snippet(text: string, maxChars: number | undefined): string {
  if (maxChars == null || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

/** One message rendered as an id-anchored transcript line. */
function formatLine(
  record: ChatMessageRecord,
  extras?: {
    labels?: Map<string, string>;
    mediaSuffixes?: Map<string, string>;
    /** Cut each line's body to this many characters (searches only). */
    maxContentChars?: number;
  },
): string {
  const reply =
    record.replyToSourceMessageId != null ? ` [reply to #${record.replyToSourceMessageId}]` : "";
  const suffix = extras?.mediaSuffixes?.get(record.sourceMessageId) ?? "";
  const author = authorOf(record, extras?.labels);
  const body = snippet(`${record.content}${suffix}`, extras?.maxContentChars);
  return `[#${record.sourceMessageId}] [${record.sentAt}] ${author}${reply}: ${body}`;
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
  extras?: {
    labels?: Map<string, string>;
    mediaSuffixes?: Map<string, string>;
    /**
     * Cut each line's body in the model-facing text. The structured payload below
     * is unaffected: it is trace-only (the loop feeds the model `result.text`
     * alone), so Debug keeps the complete bodies while the conversation carries
     * snippets.
     */
    maxContentChars?: number;
    /** Appended after the transcript — how to use the result, not what it says. */
    usageNote?: string;
  },
) {
  const messages = records.map((r) => ({
    id: r.sourceMessageId,
    replyTo: r.replyToSourceMessageId,
    role: r.role,
    content: `${r.content}${extras?.mediaSuffixes?.get(r.sourceMessageId) ?? ""}`,
    at: r.sentAt,
    author: authorOf(r, extras?.labels),
  }));
  const transcript =
    records.length === 0
      ? "(no matching messages)"
      : records.map((record) => formatLine(record, extras)).join("\n");
  const selfAuthoredOnly =
    records.length > 0 && records.every((record) => record.role === "assistant");
  const notes = [
    ...(selfAuthoredOnly ? [SELF_AUTHORED_ONLY_NOTE] : []),
    ...(extras?.usageNote && records.length > 0 ? [extras.usageNote] : []),
  ];
  const text = [transcript, ...notes].join("\n\n");
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
/**
 * Media annotations for a set of search hits: the annotation source rides
 * the mirror rows, so one by-ids read resolves every hit that has media.
 */
async function loadMediaSuffixes(
  chatRef: string,
  matches: readonly SourceMessageMatch[],
): Promise<Map<string, string>> {
  const withMedia = matches.filter((m) => m.mediaKind != null).map((m) => m.sourceMessageId);
  if (withMedia.length === 0) return new Map();
  const rows = await requireSourceContent()
    .messagesByIds(chatRef, withMedia)
    .catch(() => []);
  const suffixes = new Map<string, string>();
  for (const row of rows) {
    if (!row.media) continue;
    const suffix = renderMediaSuffix(row.media as MediaAnnotation);
    if (suffix) suffixes.set(row.sourceMessageId, suffix);
  }
  return suffixes;
}

export function mergeMatches(
  batches: SourceMessageMatch[][],
  limit: number,
): SourceMessageMatch[] {
  const best = new Map<number, SourceMessageMatch>();
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

/**
 * Strip one layer of surrounding quotes from an argument value.
 *
 * Production, 2026-08-07: the model passed `author` as the JSON string `"\"R.K.\""`
 * — the name, quoted, inside the string. Resolution is by exact name, so the
 * quotes alone would have missed a person who is unambiguously in the chat. This
 * is a mechanical fix to a mechanical mistake (a stray delimiter), not a guess at
 * what a name might mean: nothing here folds spelling, transliterates, or matches
 * approximately.
 */
const QUOTE_CHARS = ['"', "'", "`", "«", "»", "“", "”"];

export function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!QUOTE_CHARS.includes(first) || !QUOTE_CHARS.includes(last)) return trimmed;
  return trimmed.slice(1, -1).trim();
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
  source: SourceId,
  chatId: string,
  author: string,
): Promise<{ ok: true; userIds: string[] } | { ok: false; error: string }> {
  const resolved = await resolveChatUserByReference(source, chatId, author);
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
 * Appended to every non-empty search result.
 *
 * Production, 2026-08-07: asked to find a photo somebody had posted, the bot
 * answered by pasting a result line into the group verbatim — `[#13488]`, the ISO
 * timestamp, the `(@username)`, and a half-sentence of the vision description
 * with an ellipsis. The chat saw the lookup's internal format instead of an
 * answer, and the photo itself was never pointed at.
 *
 * So the result says what it is: an index, in a format that is not chat text,
 * whose ids exist to be *used*. Citing `#<id>` in an ordinary sentence is not
 * only allowed but wanted (user decision, 2026-08-07 — "I like this more, just if
 * they can be anchors"): the delivery layer turns a cited id into a tappable link
 * to that message, so "the first one was in #13488, the other two in #15114 and
 * #15115" gives the chat three working references in one reply. What must not
 * happen is the raw line being pasted around them.
 */
export const SEARCH_RESULT_USAGE_NOTE =
  "These lines are lookup output, not chat text — never paste one into a reply, and never " +
  "repeat a timestamp, a username or a [photo: …] block from it. A snippet ending in … is cut, " +
  "not the whole message. " +
  "DO cite the messages you found by their #<id> in your own ordinary sentence — a cited id " +
  "becomes a tappable link to that message, so naming them (\"the first one is in #123, the " +
  "other two in #456 and #789\") is exactly how to answer. Cite only ids from this result.";

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
  "Use it whenever the question is about what was actually SAID or POSTED here earlier — " +
  "'what did I tell you about X', 'look back through our chat', 'did we discuss X' — finding " +
  "the said words is this tool's job, not a memory lookup. " +
  "Searches by meaning as well as by wording, so describe what you are looking for in plain " +
  "words; it does not have to match how anyone phrased it, or even be the same language. " +
  "Photos, videos, GIFs, stickers and voice messages are searched by what is IN them: a " +
  "picture of a door is found by searching for a door, even when it was posted with no caption " +
  "at all. This is how to find a specific image, clip or recording somebody sent earlier. " +
  "Combine the filters with the query rather than choosing between them — \"the photo of the " +
  "door Bea sent\" is query 'door' plus author 'Bea' plus media_kinds ['photo'], all three in " +
  "ONE call. With a filter you may omit the query entirely (\"the photos Bea sent\" → author " +
  "plus media_kinds, no query), which returns her most recent ones. " +
  "Results are short snippets for identifying the right message, not the messages themselves; " +
  "each is anchored as #<id>, and that id is how you point at one afterwards.";

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
          .optional()
          .describe(
            "What to look for — a single string, or an array of phrasings searched at once. " +
              "Describe the thing in plain words; it does not have to be the wording anyone " +
              "used. Optional when 'author' or 'media_kinds' is given.",
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
      const { source, chatId } = getToolContext();
      const chatRef = scopedRef(source, "chat", chatId);
      const queries = query == null ? [] : Array.isArray(query) ? query : [query];
      const cap = limit ?? SEARCH_LIMIT_DEFAULT;
      const content = requireSourceContent();

      if (queries.length === 0 && !author && !media_kinds) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Nothing to search for: give a query, or narrow by author or media_kinds (or " +
                "both). Searching this chat with no criteria at all would just return its most " +
                "recent messages, which you already have.",
            },
          ],
          isError: true,
        };
      }

      let authorUserIds: string[] | undefined;
      if (author) {
        const resolved = await resolveAuthorFilter(source, chatId, unquote(author));
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

      // No query, only filters ("the photos she sent") — one filtered read of the
      // most recent matches, with nothing to embed or rank.
      const batches =
        queries.length === 0
          ? [
              await content.searchMessages({
                chatRef,
                queryText: "",
                queryVector: null,
                limit: cap,
                filters,
              }),
            ]
          : await Promise.all(
              queries.map(async (q) => {
                const vector = embedding ? await embedOne(embedding, q).catch(() => null) : null;
                return content.searchMessages({
                  chatRef,
                  queryText: q,
                  queryVector: vector,
                  limit: cap,
                  filters,
                });
              }),
            );

      const matches = mergeMatches(batches, cap);
      // Media annotations ride the matched rows themselves since the split —
      // one by-ids read resolves them (search hits carry only the kind).
      const [labels, mediaSuffixes] = await Promise.all([
        resolveSpeakerLabels(undefined, matches),
        loadMediaSuffixes(chatRef, matches),
      ]);
      return buildResult(matches, {
        labels,
        mediaSuffixes,
        maxContentChars: SNIPPET_CHARS,
        usageNote: SEARCH_RESULT_USAGE_NOTE,
      });
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
      const { source, chatId } = getToolContext();
      const records = await requireSourceContent().messagesWindow(scopedRef(source, "chat", chatId), {
        from: fromDate,
        to: toDate,
        endExclusive: false,
      });
      return buildResult(records);
    },
  );

  server.registerTool(
    HISTORY_GET_BY_MESSAGE_IDS_TOOL,
    {
      title: "Get messages by their ids",
      description:
        "Fetch specific messages from this conversation by their message ids. Use it " +
        "to read a message referenced as #<id> in the transcript (for example a reply target " +
        "marked [reply to #<id>]) whose content is not shown. Ids not found are omitted from " +
        "the result.",
      inputSchema: {
        ids: z
          .array(z.union([z.string().regex(/^\d+$/), z.number().int().positive()]))
          .min(1)
          .max(GET_BY_IDS_MAX)
          .describe(`Message ids to fetch, as shown after # in the transcript (max ${GET_BY_IDS_MAX})`),
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
      const { source, chatId } = getToolContext();
      const records = await requireSourceContent().messagesByIds(
        scopedRef(source, "chat", chatId),
        ids.map(String),
      );
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
            message_ids: z.array(z.string()),
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
      const { source, chatId } = getToolContext();
      const queries = Array.isArray(query) ? query : [query];
      const cap = limit ?? RECALL_LIMIT_DEFAULT;
      const matches = await recallChatTopics({
        chatRef: scopedRef(source, "chat", chatId),
        queries,
        limit: cap,
      });

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
