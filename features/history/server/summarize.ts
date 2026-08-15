import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import { newRunCorrelationId, type TraceTrigger } from "@/lib/trace";
import type {
  ChatCompletionResult,
  ChatMessage,
  LlmCallTrace,
} from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import {
  buildSummaryPrompt,
  currentSummaryDate,
  parseSummaryTopics,
  SUMMARY_SYSTEM,
  type SummaryDate,
  type SummaryTopic,
} from "../summary";
import { completeTranscriptBatches } from "./batched-completion";
import { loadChatDayTranscript } from "./service";
import {
  countDaysNeedingSummary,
  listDaysNeedingSummary,
  replaceSummariesForDay,
  type InsertChatSummary,
} from "./summaries-repository";

/**
 * History summarization — the long-term half of conversation recall.
 *
 * Each finished chat-day is compressed by the LLM into a few self-contained
 * topics, each embedded and carrying the Telegram message ids it came from. The
 * bot then searches *these* for anything older than the 24-hour window it already
 * gets verbatim, and follows the ids back to the exact original messages.
 *
 * Collaborators are injected so the whole flow can be driven in tests against a
 * real database with a deterministic model and embedder — no LLM, no network.
 */

const FEATURE = FEATURES["history-summaries"];

/**
 * Days fetched from the due-scan per iteration. Not a cap on the run: the run
 * loops until the backlog is empty, so a first run against years of imported
 * history summarizes *all* of it, oldest day first, rather than trickling 25 days
 * per night. This is only the page size of the scan.
 */
const DUE_SCAN_PAGE = 25;

/**
 * Hard stop for one run, as a safety valve rather than a policy: if a day somehow
 * fails to clear its pending state, the loop must not spin forever. A run
 * legitimately summarizing this many chat-days will simply continue on the next
 * run (the scan is resumable by construction).
 */
const MAX_DAYS_PER_RUN = 2_000;

/** The collaborators summarization needs. Injected for testability. */
export interface SummarizeDeps {
  /** Run one LLM pass (the summarizer prompt for one batch of a day). */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /**
   * Embed each topic for semantic recall. Null when embeddings are unconfigured —
   * the topics are still written and still full-text searchable, so a missing
   * embedding model degrades recall rather than losing the day's summary.
   */
  embed: ((texts: string[]) => Promise<number[][]>) | null;
  /** Operator timezone — the wall clock a "day" is measured against. */
  timeZone: string;
  now?: () => Date;
  /** Publish live per-day progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  /**
   * Correlation shared by every chat-day trace of one run, so the whole sweep
   * is traceable start to end from the Debug filter. Absent → generated.
   */
  runCorrelationId?: string;
}

/** Outcome of summarizing one chat-day. */
export interface SummarizeDayResult {
  chatId: string;
  summaryDate: SummaryDate;
  messageCount: number;
  topicCount: number;
  embedded: boolean;
}

/**
 * Summarize one chat-day: LLM over the transcript (in batches for a busy day),
 * embed the topics, replace the day's stored summaries, and stamp its marker.
 * Traced end to end — every batch's full request and response body is on the
 * trace, so the operator can see exactly what the model was shown and said.
 *
 * Idempotent: re-summarizing a day replaces its topics rather than adding to them.
 * A day that distils to nothing still stamps its marker, so it is not retried
 * forever.
 */
export async function summarizeChatDay(
  params: { chatId: string; summaryDate: SummaryDate },
  deps: SummarizeDeps,
  // The actor is the CHAT the day belongs to — see `extractChatDay`'s note:
  // ids are clickable facets, and the job's identity is the trace's feature.
  trigger: TraceTrigger = { kind: "cron", actor: params.chatId },
  db: DrizzleDb = getDb(),
): Promise<SummarizeDayResult> {
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "summarize",
      trigger,
      inputSummary: `chat ${params.chatId} · ${params.summaryDate}`,
    }
  );

  try {
    const { messages, dayMessageCount } = await loadChatDayTranscript(
      db,
      params.chatId,
      params.summaryDate,
      deps.timeZone,
    );
    await trace.event({
      type: "step",
      message: "day loaded",
      data: {
        chatId: params.chatId,
        summaryDate: params.summaryDate,
        messageCount: dayMessageCount,
        transcriptMessages: messages.length,
        timeZone: deps.timeZone,
      },
    });

    // A day with nothing readable (all rows deleted, or only blank media rows)
    // still needs its marker stamped, so it stops showing up as pending work.
    if (messages.length === 0) {
      await replaceSummariesForDay(db, {
        chatId: params.chatId,
        summaryDate: params.summaryDate,
        messageCount: dayMessageCount,
        topics: [],
      });
      await trace.skip("no messages", { outputSummary: "no messages to summarize" });
      return {
        chatId: params.chatId,
        summaryDate: params.summaryDate,
        messageCount: dayMessageCount,
        topicCount: 0,
        embedded: false,
      };
    }

    const contents = await completeTranscriptBatches({
      messages,
      buildRequest: (batch) => [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: buildSummaryPrompt(params.summaryDate, batch) },
      ],
      complete: deps.complete,
      trace,
      callKind: "history-summarize",
    });
    const topics: SummaryTopic[] = contents.flatMap(parseSummaryTopics);

    // Embed the topics so they are semantically searchable. Best-effort: a dead
    // embedding endpoint must not cost us the summaries themselves — they are
    // stored either way and remain full-text searchable.
    let vectors: number[][] | null = null;
    if (deps.embed && topics.length > 0) {
      try {
        vectors = await deps.embed(topics.map((topic) => topic.content));
      } catch (err) {
        await trace.event({
          type: "step",
          level: "warn",
          message: "embedding failed — topics stored without semantic search",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    const rows: InsertChatSummary[] = topics.map((topic, index) => ({
      content: topic.content,
      messageIds: topic.messageIds,
      embedding: vectors?.[index] ?? null,
    }));
    const stored = await replaceSummariesForDay(db, {
      chatId: params.chatId,
      summaryDate: params.summaryDate,
      messageCount: dayMessageCount,
      topics: rows,
    });

    await trace.event({
      type: "db",
      message: `${stored.length} topic(s) stored`,
      data: {
        topics: stored.map((row) => ({
          content: row.content,
          messageIds: row.messageIds,
          embedded: row.embedded,
        })),
      },
    });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });

    await trace.succeed({
      outputSummary: `${stored.length} topic(s) from ${messages.length} message(s)`,
      relatedIds: { [FEATURE.relatedIdsKey]: stored.map((row) => String(row.id)) },
    });

    return {
      chatId: params.chatId,
      summaryDate: params.summaryDate,
      messageCount: dayMessageCount,
      topicCount: stored.length,
      embedded: vectors != null,
    };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** Outcome of one full summarization run over every day still owed. */
export interface SummarizationRunResult {
  days: number;
  topics: number;
  failures: number;
  summary: string;
}

/**
 * Summarize **every** finished chat-day that has no up-to-date summary — walking
 * the whole history from its oldest day forward, not just yesterday.
 *
 * This is the entire job, and it is retroactive by construction: the due-scan
 * asks "which finished days hold messages but have no summary at their current
 * message count", which is equally true of yesterday, of a day imported from a
 * CSV last week, and of a day from two years ago that predates the feature. So
 * there is no separate backfill path to run, remember, or get wrong — the first
 * run after enabling summarization summarizes all of history, and every run
 * afterwards finds only what is genuinely new or changed.
 *
 * The scan is re-run each iteration rather than paged through once: summarizing a
 * day removes it from the scan's results, so re-asking is both correct and how the
 * loop terminates. A day that fails is recorded on its own trace, counted, and
 * *excluded* from further iterations — otherwise it would be handed back by the
 * next scan forever and the run would never end.
 */
export async function runSummarization(
  deps: SummarizeDeps,
  db: DrizzleDb = getDb(),
): Promise<SummarizationRunResult> {
  const now = deps.now?.() ?? new Date();
  const today = currentSummaryDate(now, deps.timeZone);

  let days = 0;
  let topics = 0;
  const failed = new Set<string>();
  // One correlation for the whole sweep — every summarized chat-day carries it.
  const runId = deps.runCorrelationId ?? newRunCorrelationId("history-summaries", now);
  // The backlog when the run starts is this run's denominator for the live bar;
  // days leave the scan as they are summarized, so it only shrinks from here.
  const total = await countDaysNeedingSummary(db, { timeZone: deps.timeZone, today });

  while (days + failed.size < MAX_DAYS_PER_RUN) {
    const pending = await listDaysNeedingSummary(db, {
      timeZone: deps.timeZone,
      today,
      limit: DUE_SCAN_PAGE,
    });
    // Days that already failed this run keep matching the scan (they are still
    // unsummarized), so skip them here rather than retrying them in a tight loop.
    const next = pending.filter((day) => !failed.has(`${day.chatId}|${day.summaryDate}`));
    if (next.length === 0) break;

    for (const day of next) {
      deps.onProgress?.({
        step: `Summarizing ${day.chatId} ${day.summaryDate}`,
        current: days + failed.size + 1,
        total,
      });
      try {
        const result = await summarizeChatDay(
          { chatId: day.chatId, summaryDate: day.summaryDate },
          deps,
          { kind: "cron", actor: day.chatId, correlationId: runId },
          db,
        );
        topics += result.topicCount;
        days += 1;
      } catch {
        // Already recorded on the day's own trace. Keep going so one bad day does
        // not block the rest of the backlog; it stays pending for the next run.
        failed.add(`${day.chatId}|${day.summaryDate}`);
      }
    }
  }

  if (days === 0 && failed.size === 0) {
    return { days: 0, topics: 0, failures: 0, summary: "nothing to summarize" };
  }

  return {
    days,
    topics,
    failures: failed.size,
    summary:
      `${days} day(s) summarized, ${topics} topic(s)` +
      (failed.size > 0 ? `, ${failed.size} failed` : ""),
  };
}
