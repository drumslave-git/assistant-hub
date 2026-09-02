import "server-only";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { tryParseScopedRef } from "@assistant-hub-swarm/contracts";

import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { FEATURES } from "@/lib/features";
import type {
  ChatCompletionResult,
  ChatMessage,
  LlmCallTrace,
} from "@/server/llm/client";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";

import { splitMemoryFacts } from "../format";
import {
  buildGeneralMergeRequest,
  buildUserMergeRequest,
  GENERAL_MERGE_PROMPT,
  parseMergedDocument,
  USER_MERGE_PROMPT,
} from "../prompt";
import {
  deleteMemoryEntries,
  getGeneralMemory,
  getPendingGeneralEntries,
  getPendingUserEntries,
  getUserMemory,
  listUsersWithPendingEntries,
  upsertGeneralMemory,
  upsertUserMemory,
} from "./repository";

/**
 * The nightly consolidation job: fold every pending note — from the `memory_save`
 * tool and from passive extraction alike — into durable memory.
 *
 * Two passes, one per scope, both **document merges** (operator decision,
 * 2026-07-16): existing document + its pending notes → rewritten document. Merging
 * per-document rather than per-note is what makes contradiction resolution
 * possible at all — the model sees the whole picture it is rewriting, so "moved to
 * Lisbon" can supersede "lives in Porto".
 *  - **user** — one LLM call per *person* with a backlog.
 *  - **general** — one LLM call for the single shared document.
 *
 * The general pass used to be one call per *note*, reconciling it (insert / skip /
 * replace) against the stored facts most similar to it, because general knowledge
 * was a set of independently embedded rows. It is one document now, so it merges
 * like a person's — and the whole run costs at most one general call instead of
 * one per note.
 *
 * A pass that fails leaves its notes pending for the next run rather than losing
 * them; a note that succeeds is deleted, so it is never re-spent on the LLM. An
 * empty merge is treated as a *failed* pass, never as "this is now empty", so a
 * garbage model response can never erase a document that took months to build.
 * Embeddings are optional and only affect `user` memory (general is never
 * searched): with none configured, memory is still stored and injected.
 */

const FEATURE = FEATURES.memory;

/**
 * Safety valve on one run, not a business rule — the backlog is normally a
 * handful of notes. Stops a runaway queue (or a loop bug) from spending
 * unbounded tokens in one night; the remainder is simply taken next run.
 */
const MAX_NOTES_PER_RUN = 500;

/** Collaborators, injected so tests can drive a run deterministically. */
export interface ConsolidateDeps {
  /** One LLM pass (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /** Embed texts, or null when no embedding model is configured. */
  embed: ((texts: string[]) => Promise<number[][]>) | null;
  /** Publish live per-note progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  /** Correlation shared with the extraction half of the same nightly run. */
  runCorrelationId?: string;
  db?: StoreDb;
}

export interface ConsolidateResult {
  /** People whose document was rewritten. */
  usersUpdated: number;
  /** Whether the single general document was rewritten this run. */
  generalUpdated: boolean;
  /** Notes folded in and deleted. */
  consumed: number;
  /** Notes whose pass failed; left pending for the next run. */
  failed: number;
  summary: string;
}

const EMPTY: Omit<ConsolidateResult, "summary"> = {
  usersUpdated: 0,
  generalUpdated: false,
  consumed: 0,
  failed: 0,
};

/**
 * Run one consolidation pass over the pending queue. Never throws for a per-note
 * failure. Records one trace when there is a backlog, and stays silent otherwise
 * so the nightly tick does not spam Debug with empty runs.
 */
export async function runMemoryConsolidation(deps: ConsolidateDeps): Promise<ConsolidateResult> {
  const db = deps.db ?? getStoreDb();

  const [userIds, generalEntries] = await Promise.all([
    listUsersWithPendingEntries(db),
    getPendingGeneralEntries(db),
  ]);
  if (userIds.length === 0 && generalEntries.length === 0) {
    return { ...EMPTY, summary: "nothing to consolidate" };
  }

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "consolidate",
      trigger: {
        kind: "system",
        actor: "memory",
        ...(deps.runCorrelationId ? { correlationId: deps.runCorrelationId } : {}),
      },
      inputSummary: `${userIds.length} user(s), ${generalEntries.length} general note(s) pending`,
    }
  );

  const result = { ...EMPTY };

  /** One LLM pass, recorded by the shared LLM tracing layer. Null on failure. */
  async function complete(system: string, userContent: string): Promise<string | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    try {
      const completion = await deps.complete(messages, {
        recorder: trace,
        callKind: "memory-consolidate",
      });
      return completion.content;
    } catch (err) {
      result.failed += 1;
      await trace.event({
        type: "error",
        level: "warn",
        message: "LLM pass failed — notes left pending for the next run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  /**
   * Embed one text, or null when embeddings are unconfigured or the call failed.
   * A failure is degradation, not an error: the row is stored unembedded (and
   * shown as such on the dashboard) rather than the whole note being lost.
   */
  async function embedOne(text: string): Promise<number[] | null> {
    if (!deps.embed) return null;
    try {
      const [vector] = await deps.embed([text]);
      return vector ?? null;
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: "embedding failed — memory stored without semantic search",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  try {
    let budget = MAX_NOTES_PER_RUN;
    // Combined denominator across both passes; a running index for the live bar.
    const total = userIds.length + generalEntries.length;
    let processed = 0;

    /* Pass 1 — one document merge per person. */
    for (const userId of userIds) {
      if (budget <= 0) break;
      const entries = (await getPendingUserEntries(db, userId)).slice(0, budget);
      if (entries.length === 0) continue;

      // The backlog keys are scoped refs (Phase 10); label tg identities
      // from the directory, everyone else by their ref.
      const parsed = tryParseScopedRef(userId);
      const [user] =
        parsed?.source === "tg" ? await getKnownUsersByIds(db, [parsed.id]) : [undefined];
      const label = user ? formatKnownUserLabel(user) : `User ${userId}`;
      deps.onProgress?.({ step: `Consolidating memory of ${label}`, current: ++processed, total });
      const existing = await getUserMemory(db, userId);
      const existingFacts = existing ? splitMemoryFacts(existing.content) : [];

      await trace.event({
        type: "step",
        message: `merge memory of ${label}`,
        data: {
          userId,
          label,
          existingFacts: existingFacts.length,
          incomingNotes: entries.length,
        },
      });

      const content = await complete(
        USER_MERGE_PROMPT,
        buildUserMergeRequest({
          label,
          existing: existingFacts,
          incoming: entries.map((e) => e.content),
        }),
      );
      if (!content) continue;

      const merged = parseMergedDocument(content);
      if (merged.length === 0) {
        // An empty merge means the model returned nothing usable. Treat it as a
        // failed pass, NOT as "this person has no memory" — acting on it would
        // erase a document that took months to accumulate. The notes stay pending.
        result.failed += 1;
        await trace.event({
          type: "step",
          level: "warn",
          message: "merge produced no document — memory left untouched, notes left pending",
          data: { userId, content },
        });
        continue;
      }

      const document = merged.join("\n");
      const stored = await upsertUserMemory(db, {
        userId,
        content: document,
        embedding: await embedOne(document),
      });

      await deleteMemoryEntries(
        db,
        entries.map((e) => e.id),
      );
      budget -= entries.length;
      result.consumed += entries.length;
      result.usersUpdated += 1;

      await trace.event({
        type: "step",
        level: "success",
        message: `memory of ${label} updated`,
        data: {
          userId,
          factsBefore: existingFacts.length,
          factsAfter: merged.length,
          notesFolded: entries.length,
          embedded: stored.embedded,
          document,
        },
      });
    }

    /* Pass 2 — one merge for the single general document. */
    const generalBatch = generalEntries.slice(0, Math.max(budget, 0));
    if (generalBatch.length > 0) {
      deps.onProgress?.({
        step: "Merging general knowledge",
        current: ++processed,
        total,
      });

      const existingDoc = await getGeneralMemory(db);
      const existingFacts = existingDoc ? splitMemoryFacts(existingDoc.content) : [];

      await trace.event({
        type: "step",
        message: "merge general knowledge",
        data: {
          existingFacts: existingFacts.length,
          incomingNotes: generalBatch.length,
        },
      });

      const content = await complete(
        GENERAL_MERGE_PROMPT,
        buildGeneralMergeRequest({
          existing: existingFacts,
          incoming: generalBatch.map((e) => e.content),
        }),
      );

      if (content) {
        const merged = parseMergedDocument(content);
        if (merged.length === 0) {
          // Same rule as the user pass: an empty merge is a failed pass, NOT
          // "general knowledge is now empty". Acting on it would erase the whole
          // shared document. The notes stay pending.
          result.failed += 1;
          await trace.event({
            type: "step",
            level: "warn",
            message: "merge produced no document — general knowledge left untouched, notes left pending",
            data: { content },
          });
        } else {
          const document = merged.join("\n");
          await upsertGeneralMemory(db, document);
          await deleteMemoryEntries(
            db,
            generalBatch.map((e) => e.id),
          );
          result.consumed += generalBatch.length;
          result.generalUpdated = true;

          await trace.event({
            type: "step",
            level: "success",
            message: "general knowledge updated",
            data: {
              factsBefore: existingFacts.length,
              factsAfter: merged.length,
              notesFolded: generalBatch.length,
              document,
            },
          });
        }
      }
    }

    const summary =
      `${result.usersUpdated} user memor${result.usersUpdated === 1 ? "y" : "ies"} updated, ` +
      (result.generalUpdated ? "general knowledge updated" : "general knowledge unchanged") +
      (result.failed > 0 ? `, ${result.failed} left pending` : "");

    await trace.succeed({ outputSummary: summary });
    publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
    return { ...result, summary };
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
