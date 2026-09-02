import "server-only";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { completeTranscriptBatches } from "@/features/history/server/batched-completion";
import { loadChatDayTranscript } from "@/features/history/server/service";
import {
  requireSourceContent,
  type SourceContentClient,
} from "@/server/source/content";
import { parseScopedRef } from "@assistant-hub-swarm/contracts";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { currentSummaryDate, type SummaryDate } from "@/features/history/summary";
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
  buildExtractionRequest,
  EXTRACTION_SYSTEM,
  parseExtractedNotes,
  participantsOf,
  type ExtractedNote,
} from "../extract-prompt";
import {
  listDaysNeedingExtraction,
  stampExtractionDay,
  countDaysNeedingExtraction,
} from "./extraction-repository";
import { saveMemoryNote } from "./service";

/**
 * **Passive memory extraction** — the producer that lets the bot remember things
 * nobody said to its face.
 *
 * The pending queue's only producer used to be the `memory_save` tool, which the
 * model can call solely while composing a reply — and a reply only happens when
 * the bot is addressed (`features/bot-messaging/server/addressing.ts`). In a group
 * that meant the bot learned from the few turns aimed at it and remembered nothing
 * from the conversation going on around it, which is where people actually mention
 * where they live, what they do, and who they are.
 *
 * Nothing about addressing changes to fix that. The history mirror already records
 * **every** message regardless of addressing, so this job reads the mirror: one
 * LLM pass per finished chat-day, harvesting durable facts into the same
 * `memory_entries` queue the tool writes to. The consolidation pass then folds
 * them into durable memory exactly as it always has — it neither knows nor cares
 * which producer queued a note.
 *
 * Collaborators are injected so the whole flow can be driven in tests against a
 * real database with a deterministic model — no LLM, no network.
 */

const FEATURE = FEATURES["memory-extraction"];

/**
 * Days fetched per due-scan iteration. Not a cap on the run: the loop re-scans
 * until the backlog is empty, so the first run reads *all* of history rather than
 * trickling a page per night. Only the scan's page size.
 */
const DUE_SCAN_PAGE = 25;

/**
 * Hard stop for one run — a safety valve, not a policy. If a day somehow fails to
 * clear its pending state the loop must not spin forever; a run legitimately
 * extracting this many chat-days simply continues on the next one (the scan is
 * resumable by construction).
 */
const MAX_DAYS_PER_RUN = 2_000;

/** Collaborators, injected so tests can drive a run deterministically. */
export interface ExtractDeps {
  /** One LLM pass (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /** Operator timezone — the wall clock a "day" is measured against. */
  timeZone: string;
  now?: () => Date;
  /** Publish live per-day progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  /**
   * Correlation shared by every trace of one nightly run (the scheduler runs
   * extraction and consolidation under one id). Absent → the run generates its
   * own, so a standalone extraction is still internally correlated.
   */
  runCorrelationId?: string;
  /** The owning source's content (real: the tg internal API). */
  content?: SourceContentClient;
}

/** Outcome of extracting one chat-day. */
export interface ExtractDayResult {
  chatRef: string;
  extractionDate: SummaryDate;
  messageCount: number;
  /** Facts actually queued (after validation and duplicate filtering). */
  noteCount: number;
}

/** Queue one day's extracted facts, counting only what the service accepted. */
async function queueNotes(
  notes: readonly ExtractedNote[],
  chatRef: string,
  db: StoreDb,
): Promise<{ queued: ExtractedNote[]; rejected: { note: ExtractedNote; error: string }[] }> {
  const queued: ExtractedNote[] = [];
  const rejected: { note: ExtractedNote; error: string }[] = [];

  const { source, id: chatId } = parseScopedRef(chatRef);
  for (const note of notes) {
    // Through the same service the tool writes with, so a passively extracted note
    // clears exactly the same bar as one the model saved by hand — in particular
    // the known-user check, which is the last thing standing between a
    // hallucinated id and a document filed under a stranger.
    const outcome = await saveMemoryNote(
      {
        scope: note.scope,
        userId: note.scope === "user" ? note.userId : null,
        content: note.content,
        source,
        chatId,
      },
      db,
    );
    if (outcome.ok) queued.push(note);
    else rejected.push({ note, error: outcome.error });
  }

  return { queued, rejected };
}

/**
 * Extract one chat-day into pending notes. Traced end to end — every batch's full
 * request and response body is recorded, so the operator can see exactly what the
 * model was shown and what it decided was worth remembering.
 *
 * Idempotent at the day level: re-extracting a day stamps its marker again rather
 * than accumulating markers. Re-extraction *can* re-queue a fact already
 * consolidated (the note it came from is long deleted by then, so there is nothing
 * here to compare against) — that is deliberate and harmless: the consolidation
 * passes exist precisely to decide "already known" and will skip it, or merge it
 * into a document that already says it. Correctness is the consolidator's job; this
 * job's job is not to lose anything.
 *
 * A day whose transcript yields nothing still stamps its marker, so a day of pure
 * chit-chat is never re-spent on the LLM.
 */
export async function extractChatDay(
  params: { chatRef: string; extractionDate: SummaryDate },
  deps: ExtractDeps,
  // The actor is the CHAT the day belongs to (like a task fire's), so the chat
  // id is a clickable, filterable facet (`/debug?actor=<chatRef>`) — the job's
  // own identity is already the trace's feature. User rule, 2026-08-15: every
  // URL filter is a UI affordance, and ids must be facets, not free text.
  trigger: TraceTrigger = { kind: "cron", actor: params.chatRef },
  db: StoreDb = getStoreDb(),
): Promise<ExtractDayResult> {
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "extract",
      trigger,
      inputSummary: `chat ${params.chatRef} · ${params.extractionDate}`,
    }
  );

  try {
    const content = deps.content ?? requireSourceContent();
    const { messages, dayMessageCount } = await loadChatDayTranscript(
      content,
      db,
      params.chatRef,
      params.extractionDate,
      deps.timeZone,
    );
    const speakers = participantsOf(messages);
    // Only people with a `known_users` row can have a fact stored against them
    // (`memory_entries.user_id` references it). History can hold speakers who were
    // never registered — imported history routinely does — and offering their ids
    // to the model just yields good facts the store then refuses. So the roster is
    // the storable subset, and the rest stay in the transcript as context only.
    const known = await getKnownUsersByIds(
      db,
      parseScopedRef(params.chatRef).source,
      speakers.map((s) => s.userId),
    );
    // Aliases come from `known_users`, never from the transcript: the roster has to
    // be matchable against the nicknames the group actually uses, or a person's own
    // statement about themselves goes unattributed and is dropped.
    const aliasesById = new Map(known.map((u) => [u.userId, u.aliases]));
    const participants = speakers
      .filter((s) => aliasesById.has(s.userId))
      .map((s) => ({ ...s, aliases: aliasesById.get(s.userId) ?? [] }));
    const unstorable = speakers.filter((s) => !aliasesById.has(s.userId));

    await trace.event({
      type: "step",
      message: "day loaded",
      data: {
        chatRef: params.chatRef,
        extractionDate: params.extractionDate,
        messageCount: dayMessageCount,
        transcriptMessages: messages.length,
        participants,
        // Named explicitly: this is the difference between "the day was quiet" and
        // "the bot cannot remember these people yet", which look identical in the
        // note count.
        unstorableSpeakers: unstorable,
        timeZone: deps.timeZone,
      },
    });

    if (unstorable.length > 0) {
      await trace.event({
        type: "step",
        level: "warn",
        message: `${unstorable.length} speaker(s) are not known users — facts about them cannot be stored`,
        data: { unstorable },
      });
    }

    // A day with nothing readable (all rows deleted, or only blank media rows)
    // still needs its marker stamped, so it stops coming back as pending work.
    if (messages.length === 0) {
      await stampExtractionDay(db, { ...params, messageCount: dayMessageCount, noteCount: 0 });
      await trace.skip("no messages", { outputSummary: "no messages to extract" });
      return { ...params, messageCount: dayMessageCount, noteCount: 0 };
    }

    const rosterIds = participants.map((p) => p.userId);
    const contents = await completeTranscriptBatches({
      messages,
      buildRequest: (batch) => [
        { role: "system", content: EXTRACTION_SYSTEM },
        {
          role: "user",
          content: buildExtractionRequest(params.extractionDate, batch, participants),
        },
      ],
      complete: deps.complete,
      trace,
      callKind: "memory-extract",
    });
    // Each batch is validated against the *day's* full roster, not the batch's:
    // a person can speak in the morning and be talked about in the evening, and
    // a fact about them extracted from the later batch is still about them.
    const proposed: ExtractedNote[] = contents.flatMap((content) =>
      parseExtractedNotes(content, rosterIds),
    );

    const { queued, rejected } = await queueNotes(proposed, params.chatRef, db);

    if (rejected.length > 0) {
      await trace.event({
        type: "step",
        level: "warn",
        message: `${rejected.length} extracted fact(s) rejected — not queued`,
        data: { rejected },
      });
    }

    await stampExtractionDay(db, {
      ...params,
      messageCount: dayMessageCount,
      noteCount: queued.length,
    });

    await trace.event({
      type: "db",
      message: `${queued.length} fact(s) queued for consolidation`,
      data: { notes: queued },
    });
    if (queued.length > 0) publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });

    await trace.succeed({
      outputSummary: `${queued.length} fact(s) from ${messages.length} message(s)`,
    });

    return {
      ...params,
      messageCount: dayMessageCount,
      noteCount: queued.length,
    };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}

/** Outcome of one full extraction run over every day still owed. */
export interface ExtractionRunResult {
  days: number;
  notes: number;
  failures: number;
  summary: string;
}

/**
 * Extract **every** finished chat-day the job has not already read at its current
 * message count — walking the whole mirror from its oldest day forward.
 *
 * Retroactive by construction, like the summarizer: there is no separate backfill
 * path to run or forget, because the due-scan cannot tell the difference between
 * yesterday and a day from two years ago that predates the feature. The first run
 * after this ships mines everything the bot ever sat silently through.
 *
 * The scan is re-run each iteration rather than paged through once: extracting a
 * day removes it from the scan's results, which is both why re-asking is correct
 * and how the loop terminates. A day that throws is recorded on its own trace,
 * counted, and excluded from later iterations — otherwise the next scan would hand
 * it back forever and the run would never end.
 */
export async function runMemoryExtraction(
  deps: ExtractDeps,
  db: StoreDb = getStoreDb(),
): Promise<ExtractionRunResult> {
  const now = deps.now?.() ?? new Date();
  const today = currentSummaryDate(now, deps.timeZone);
  const content = deps.content ?? requireSourceContent();

  let days = 0;
  let notes = 0;
  const failed = new Set<string>();
  // One correlation for the whole sweep: every chat-day this run extracts
  // carries it, so the run is traceable start to end from the Debug filter.
  const runId = deps.runCorrelationId ?? newRunCorrelationId("memory-extraction", now);
  // The backlog when the run starts is this run's denominator for the live bar;
  // days leave the scan as they are extracted, so it only shrinks from here.
  const total = await countDaysNeedingExtraction(content, db, { timeZone: deps.timeZone, today });

  while (days + failed.size < MAX_DAYS_PER_RUN) {
    const pending = await listDaysNeedingExtraction(content, db, {
      timeZone: deps.timeZone,
      today,
      limit: DUE_SCAN_PAGE,
    });
    // Days that already failed this run still match the scan (they are still
    // unextracted), so skip them rather than retrying in a tight loop.
    const next = pending.filter((day) => !failed.has(`${day.chatRef}|${day.extractionDate}`));
    if (next.length === 0) break;

    for (const day of next) {
      deps.onProgress?.({
        step: `Extracting memory from ${day.chatRef} ${day.extractionDate}`,
        current: days + failed.size + 1,
        total,
      });
      try {
        const result = await extractChatDay(
          { chatRef: day.chatRef, extractionDate: day.extractionDate },
          deps,
          { kind: "cron", actor: day.chatRef, correlationId: runId },
          db,
        );
        notes += result.noteCount;
        days += 1;
      } catch {
        // Already recorded on the day's own trace. Keep going so one bad day does
        // not block the backlog; it stays pending for the next run.
        failed.add(`${day.chatRef}|${day.extractionDate}`);
      }
    }
  }

  if (days === 0 && failed.size === 0) {
    return { days: 0, notes: 0, failures: 0, summary: "nothing to extract" };
  }

  return {
    days,
    notes,
    failures: failed.size,
    summary:
      `${days} day(s) read, ${notes} fact(s) queued` +
      (failed.size > 0 ? `, ${failed.size} failed` : ""),
  };
}
