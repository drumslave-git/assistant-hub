import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { renderMediaSuffix } from "@/features/vision/format";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { withAdvisoryLock } from "@/server/jobs/lock";
import type { JobProgress } from "@/server/jobs/progress";
import { embed, type EmbeddingRuntime } from "@/server/llm/embeddings";
import { startTrace } from "@/server/trace";

import {
  countMessagesNeedingIndex,
  listMessagesNeedingIndex,
  upsertMessageIndex,
  type IndexedMessage,
  type UnindexedMessage,
} from "./search-repository";

/**
 * Message search-indexing job — build the searchable text of every mirrored
 * message and embed it, so `history_search` can find things by meaning and not
 * only by the words someone happened to type.
 *
 * The job exists because the two halves of a message arrive at different times.
 * The text is mirrored the instant the message lands; a photo's description is
 * written later by the vision backfill, and a voice note's transcript later
 * still. Indexing in the live path would therefore index most media as `[photo]`
 * and never revisit it — so it runs in the background, and re-reads any message
 * whose sources changed since it was last indexed (see `search-repository.ts`).
 *
 * Same operating model as the vision backfill: the shared idle scheduler runs it
 * only while the bot is quiet, a cross-process advisory lock keeps two processes
 * off it, and re-running is harmless (an up-to-date row is not due).
 */

const FEATURE_ID = FEATURES["history-index"].id;
const JOB_NAME = "history-index";

/**
 * Messages per embedding call. Batched because embedding endpoints charge the
 * round trip, not the token: 64 short texts in one request cost a fraction of 64
 * requests. Kept modest so an aborted run loses at most one batch of work.
 */
const BATCH_SIZE = 64;

/** Safety cap on messages attempted per run, so one run cannot spin forever. */
const MAX_MESSAGES_PER_RUN = 2_000;

export interface IndexMessagesOptions {
  /** Cooperative stop signal from the scheduler; checked between batches. */
  isAborted?: () => boolean;
  /** What triggered the run (idle scheduler → system; a dashboard run → dashboard). */
  trigger?: TraceTrigger;
  /** Publish live progress to the scheduler (drives the dashboard card). */
  onProgress?: (progress: JobProgress | null) => void;
}

export interface IndexMessagesResult {
  /** Messages written to the index this run. */
  indexed: number;
  /** Of those, how many carry an embedding (the rest are lexical-only). */
  embedded: number;
  /** Batches whose embedding call failed — left due, retried next run. */
  failedBatches: number;
  /** True when the run stopped early because live activity resumed. */
  interrupted: boolean;
  summary: string;
}

/**
 * The text that stands in for a message when searching: what it says, plus what
 * its media shows.
 *
 * This is deliberately the *same* rendering the reply transcript uses
 * (`renderMediaSuffix`), so what the model can find is what the model would have
 * read. A photo with no caption indexes as `[photo: a weathered blue front door
 * with a brass number 12…]` — which is the whole point, since its own text is
 * empty and no amount of lexical search over `chat_messages` could ever reach it.
 */
export function buildSearchableText(message: UnindexedMessage): string {
  const suffix = message.media ? renderMediaSuffix(message.media) : "";
  return `${message.content}${suffix}`.trim();
}

function summarize(result: Omit<IndexMessagesResult, "summary">): string {
  if (result.indexed === 0 && result.failedBatches === 0) {
    return result.interrupted ? "interrupted, nothing done" : "index up to date";
  }
  const parts = [`${result.indexed} indexed`];
  if (result.embedded < result.indexed) {
    parts.push(`${result.embedded} embedded`);
  }
  if (result.failedBatches > 0) parts.push(`${result.failedBatches} batch(es) failed`);
  if (result.interrupted) parts.push("interrupted");
  return parts.join(", ");
}

/**
 * Embed one batch, or return null when embeddings are unavailable.
 *
 * Unavailable splits two ways on purpose. **Unconfigured** (no runtime) is not a
 * failure: the rows are still written with a null vector, so full-text and
 * substring search work and the backlog drains. A **failed call** is a failure —
 * the rows are left due, because writing them with a null vector would mark them
 * indexed and quietly deny them a vector forever.
 */
async function embedBatch(
  runtime: EmbeddingRuntime | null,
  texts: string[],
): Promise<number[][] | null> {
  if (!runtime || texts.length === 0) return null;
  return embed(runtime, texts);
}

/**
 * Run one indexing pass. Never throws — any failure settles the trace and comes
 * back as a summary. Skipped when the advisory lock is held elsewhere.
 */
export async function runMessageIndexing(
  options: IndexMessagesOptions = {},
  db: DrizzleDb = getDb(),
): Promise<IndexMessagesResult> {
  const isAborted = options.isAborted ?? (() => false);
  const onProgress = options.onProgress ?? (() => {});
  const trigger: TraceTrigger = options.trigger ?? { kind: "system", actor: JOB_NAME };

  const trace = await startTrace({
    feature: FEATURE_ID,
    action: "index",
    trigger,
    inputSummary: "index messages for search",
  });

  try {
    // Read once per run, not per batch: a settings change takes effect on the
    // next run, and a run that started without embeddings stays consistent about
    // it rather than half-embedding its own backlog.
    const runtime = await getEmbeddingRuntime(db).catch(() => null);

    const lock = await withAdvisoryLock(
      JOB_NAME,
      async (): Promise<IndexMessagesResult> => {
        let indexed = 0;
        let embedded = 0;
        let failedBatches = 0;
        let interrupted = false;
        let attempted = 0;
        // The backlog when the run starts is this run's denominator; messages
        // leave it as they are indexed, so it only shrinks from here.
        const total = await countMessagesNeedingIndex(db);

        while (attempted < MAX_MESSAGES_PER_RUN) {
          if (isAborted()) {
            interrupted = true;
            break;
          }
          const batch = await listMessagesNeedingIndex(db, BATCH_SIZE);
          if (batch.length === 0) break;
          attempted += batch.length;
          onProgress({ step: "Indexing messages", current: attempted, total });

          const texts = batch.map(buildSearchableText);
          // An empty message (no text, no media) is written with no vector: there
          // is nothing to embed, and leaving it out would keep it due forever and
          // the scan would hand back the same rows on every pass.
          const embeddable = batch
            .map((message, i) => ({ message, text: texts[i], i }))
            .filter((entry) => entry.text.length > 0);

          let vectors: number[][] | null = null;
          try {
            vectors = await embedBatch(
              runtime,
              embeddable.map((entry) => entry.text),
            );
          } catch (err) {
            // Leave the whole batch due and stop: an embedding endpoint that
            // just failed will most likely fail the next batch too, and the run
            // reruns on its own schedule.
            failedBatches += 1;
            await trace.event({
              type: "step",
              level: "warn",
              message: "embedding call failed — batch left for the next run",
              data: { size: embeddable.length, error: err instanceof Error ? err.message : String(err) },
            });
            break;
          }

          const vectorByIndex = new Map<number, number[]>();
          if (vectors) {
            embeddable.forEach((entry, position) => {
              const vector = vectors[position];
              if (vector) vectorByIndex.set(entry.i, vector);
            });
          }

          const rows: IndexedMessage[] = batch.map((message, i) => ({
            chatId: message.chatId,
            telegramMessageId: message.telegramMessageId,
            content: texts[i],
            embedding: vectorByIndex.get(i) ?? null,
          }));
          await upsertMessageIndex(db, rows);
          indexed += rows.length;
          embedded += vectorByIndex.size;
        }

        const result = {
          indexed,
          embedded,
          failedBatches,
          interrupted,
        };
        await trace.event({
          type: "db",
          message: "index pass complete",
          data: { ...result, attempted, embeddings: runtime ? runtime.model : null },
        });
        return { ...result, summary: summarize(result) };
      },
      db,
    );

    if (!lock.ran) {
      const summary = "skipped — another run holds the lock";
      await trace.skip(summary);
      return { indexed: 0, embedded: 0, failedBatches: 0, interrupted: false, summary };
    }

    await trace.succeed({ outputSummary: lock.result.summary });
    return lock.result;
  } catch (err) {
    await trace.fail(err);
    return {
      indexed: 0,
      embedded: 0,
      failedBatches: 0,
      interrupted: false,
      summary: err instanceof Error ? err.message : String(err),
    };
  }
}
