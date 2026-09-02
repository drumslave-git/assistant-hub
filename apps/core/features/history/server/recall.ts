import "server-only";

import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { embedOne } from "@/server/llm/embeddings";
import {
  requireSourceContent,
  type SourceContentClient,
  type SourceSummaryMatch,
} from "@/server/source/content";

/**
 * Long-term recall: find the past topics of one chat that match what is being
 * asked about. Backs the `history_recall_topics` MCP tool, and is the reason the
 * summaries exist.
 *
 * Each query is searched independently (the model may pass several phrasings) and
 * the hits are merged, keeping each topic's best score — a topic that ranks under
 * two different phrasings should not be penalized for it.
 */

/** Recall past topics in a chat. Never throws: a recall failure must not fail a reply. */
export async function recallChatTopics(
  params: { chatRef: string; queries: string[]; limit: number },
  content: SourceContentClient = requireSourceContent(),
): Promise<SourceSummaryMatch[]> {
  // Embeddings are optional. Without a configured model the search runs on full
  // text alone — worse recall, but the tool still works, which beats telling the
  // model "unavailable" and having it claim it cannot remember.
  const embedding = await getEmbeddingRuntime().catch(() => null);

  const best = new Map<number, SourceSummaryMatch>();
  for (const query of params.queries) {
    let vector: number[] | null = null;
    if (embedding) {
      vector = await embedOne(embedding, query).catch(() => null);
    }
    const matches = await content.searchSummaries({
      chatRef: params.chatRef,
      queryText: query,
      queryVector: vector,
      limit: params.limit,
    });
    for (const match of matches) {
      const existing = best.get(match.id);
      if (!existing || match.score > existing.score) best.set(match.id, match);
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit);
}
