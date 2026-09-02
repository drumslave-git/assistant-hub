import "server-only";

import { parseScopedRef, type FeedbackRecordedEvent } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { FEATURES } from "@/lib/features";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { recordAddressingExclusion } from "./addressing-report";
import { resolveFeedbackPorts, type FeedbackPorts } from "./feedback-store";
import { reflectOnFeedback, resolveReflectionDeps, type ReflectionDeps } from "./reflect";
import { resolveReplyModel } from "./service";

/**
 * What the core does the moment the owning source records a completed
 * feedback (the `feedback.recorded` bus event) — the learning half of the
 * v1 answer flows, which collected AND acted in one process:
 *
 *  - stamp the reacted reply's clean model onto the row (resolved from the
 *    reply trace, which only the core can read);
 *  - a `quality` answer → the self-reflection pass (the reasoned form both
 *    daily folds read);
 *  - an `addressing` answer ("wasn't talking to you") → file the word that
 *    mis-triggered the analyzer as an exclusion, so the next message using
 *    it does not summon the bot again. Nothing reflects on it and no fold
 *    reads it (user decision, 2026-07-26).
 *
 * Best-effort by consequence, like v1: the answer is already stored by the
 * source; anything that fails here is recorded on the trace and picked up
 * by the daily job (missing reflections) or simply stands as an unstamped
 * model.
 */

const FEATURE = FEATURES["user-feedback"];

export interface RecordedConsumerDeps {
  ports: FeedbackPorts;
  /** Null skips reflection (no LLM configured) — the daily job backfills. */
  reflection: ReflectionDeps | null;
  db?: StoreDb;
}

/** Handle one recorded feedback end to end. Never throws (bus consumer). */
export async function handleFeedbackRecorded(
  event: FeedbackRecordedEvent,
  deps?: RecordedConsumerDeps,
): Promise<void> {
  const ports = deps?.ports ?? resolveFeedbackPorts();
  if (!ports) {
    console.error(
      "feedback.recorded received but the telegram service is not configured — learning skipped",
    );
    return;
  }
  const db = deps?.db ?? getStoreDb();
  const chatId = parseScopedRef(event.feedback.chatRef).id;

  const trace = await startTrace({
    feature: FEATURE.id,
    action: "recorded",
    trigger: {
      kind: "transport",
      actor: parseScopedRef(event.feedback.userRef).id,
      correlationId: event.correlationId,
    },
    inputSummary: `${event.feedback.reaction === "up" ? "👍" : "👎"} ${event.feedback.text}`,
  });
  try {
    const feedback = await ports.feedbacks.get(event.feedback.id);
    if (!feedback) {
      await trace.skip(`feedback ${event.feedback.id} not found in the source store`);
      return;
    }

    // The model stamp is informational and must never block the learning
    // steps below.
    try {
      const model = await resolveReplyModel(
        ports.messages,
        feedback.source,
        chatId,
        feedback.sourceMessageId,
      );
      if (model) {
        await ports.feedbacks.patch(feedback.id, { model });
        feedback.model = model;
      }
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: "reply model could not be stamped",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    if (feedback.topic === "addressing") {
      // A routing report, acted on here and now — see addressing-report.ts.
      const report = await recordAddressingExclusion(db, ports.messages, feedback, trace);
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary:
          report.status === "excluded" || report.status === "already_excluded"
            ? `"${report.exclusion.term}" excluded from addressing`
            : report.reason,
        relatedIds: { [FEATURE.relatedIdsKey]: [feedback.id] },
      });
      return;
    }

    const reflection = deps ? deps.reflection : await resolveReflectionDeps();
    if (reflection) {
      // Records its own `reflect` trace; a failure leaves the column null
      // for the daily job's backfill pass.
      await reflectOnFeedback(feedback, reflection);
    } else {
      await trace.event({
        type: "step",
        level: "warn",
        message: "no LLM configured — reflection left for the daily incorporation run",
      });
    }
    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: event.feedback.text,
      relatedIds: { [FEATURE.relatedIdsKey]: [feedback.id] },
    });
  } catch (err) {
    await trace.fail(err).catch(() => undefined);
  }
}
