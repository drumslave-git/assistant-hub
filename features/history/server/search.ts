import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { embedOne } from "@/server/llm/embeddings";
import { getLatestTraceIdsByCorrelation } from "@/server/trace";

import { searchChatMessagesHybrid, type MessageSearchMatch } from "./search-repository";
import { resolveSpeakerLabels, traceCorrelationFor } from "./service";

/**
 * Operator-side message search: the dashboard's search box, over the same hybrid
 * index the bot's `history_search` reads.
 *
 * Two things separate it from the tool's use of that index. It searches **every**
 * chat by default, because the operator is looking for a message and a chat id is
 * not how a person remembers one; and each hit is annotated for a human reader —
 * the sender's known-user label instead of a numeric id, and the id of the trace
 * that handled that turn, so a found message is one click from why the bot did
 * what it did.
 *
 * Untraced, like every other dashboard read (`getChatHistory`,
 * `getHistoryOverview`): recording a trace for looking at stored data would bury
 * the actions worth reading in the noise of reading them.
 */

/**
 * How many hits the dashboard asks for.
 *
 * Kept modest because a semantic half always returns its nearest N whether or
 * not any of them are close: with an embedding model configured, *every* query
 * fills the page, and the tail is noise the reader has to scroll past. Ranking
 * puts the real matches on top, so a shorter list loses nothing and the copy
 * says plainly that these are the closest messages, not the matching ones.
 */
export const MESSAGE_SEARCH_LIMIT = 25;

/** A search hit, resolved for display. */
export interface MessageSearchHit extends MessageSearchMatch {
  /** Known-user label of the sender, or null for the bot's own rows. */
  senderLabel: string | null;
  /** Trace that handled this message's turn, when one is still stored. */
  traceId: string | null;
}

/**
 * Search stored messages. Never throws on a missing embedding model: without one
 * the hybrid search runs on its lexical halves alone — worse recall, but a
 * working search, which is the same degraded mode the bot's tool runs in.
 */
export async function searchHistoryMessages(
  params: { query: string; chatId?: string | null; limit?: number },
  db: DrizzleDb = getDb(),
): Promise<MessageSearchHit[]> {
  const query = params.query.trim();
  if (!query) return [];

  const embedding = await getEmbeddingRuntime(db).catch(() => null);
  const vector = embedding ? await embedOne(embedding, query).catch(() => null) : null;

  const matches = await searchChatMessagesHybrid(db, {
    chatId: params.chatId ?? null,
    queryText: query,
    queryVector: vector,
    limit: params.limit ?? MESSAGE_SEARCH_LIMIT,
  });
  if (matches.length === 0) return [];

  const correlations = matches
    .map(traceCorrelationFor)
    .filter((value): value is string => value != null);
  const [labels, traceIds] = await Promise.all([
    resolveSpeakerLabels(db, matches),
    getLatestTraceIdsByCorrelation(correlations),
  ]);

  return matches.map((match) => {
    const correlation = traceCorrelationFor(match);
    return {
      ...match,
      senderLabel: match.userId ? (labels.get(match.userId) ?? null) : null,
      traceId: correlation ? (traceIds.get(correlation) ?? null) : null,
    };
  });
}
