import "server-only";

import { randomUUID } from "node:crypto";

import type { StoreDb } from "@/server/store/db";
import { readAddressingCheck } from "@/features/bot-messaging/addressing-trace";
import { normalizeExclusionTerm, type AddressingExclusion } from "@/features/bot-messaging/exclusions";
import { insertAddressingExclusion } from "@/features/bot-messaging/server/exclusions-repository";
import type { TraceRecorder } from "@/server/trace";
import type { UserFeedback } from "../types";
import { getReplyTrace } from "./exchange";
import type { SourceMessagePort } from "./feedback-store";

/**
 * "Wasn't talking to you" → an addressing exclusion.
 *
 * The bot only ever answers an unaddressed message one way: the addressing
 * analyzer read a word in it as the bot's display name in another alphabet or an
 * inflected form, and was wrong — two names the model believes are one name.
 * The word it cited is on the reply's trace, so the report needs no guesswork
 * and no second LLM call: read the decision back, and file the cited word.
 *
 * Everything that is *not* that case resolves with a reason instead of an
 * exclusion. The complaint is still recorded (the feedback row is stored either
 * way) — it just has no word to act on, and the trace says which of the honest
 * reasons applied rather than silently doing nothing.
 */

/** What a report produced. Only `excluded` changes future addressing. */
export type AddressingReportOutcome =
  | { status: "excluded"; exclusion: AddressingExclusion }
  | { status: "already_excluded"; exclusion: AddressingExclusion }
  /** The reply was addressed by a mechanism with no word to blame, or none is recorded. */
  | { status: "no_match"; reason: string; source?: string | null };

/**
 * Record the exclusion behind a "wasn't talking to you" answer. Traced on the
 * caller's feedback trace — the operator reads the whole report as one story.
 * Never throws: the answer is already stored, and a failed exclusion must not
 * fail the press.
 */
export async function recordAddressingExclusion(
  db: StoreDb,
  messages: SourceMessagePort,
  feedback: UserFeedback,
  trace: TraceRecorder,
): Promise<AddressingReportOutcome> {
  try {
    const replyTrace = await getReplyTrace(messages, feedback.chatId, feedback.telegramMessageId);
    const decision = replyTrace ? readAddressingCheck(replyTrace) : null;
    if (!decision) {
      return await noMatch(
        trace,
        "no addressing decision on the reply's trace — nothing to exclude",
        null,
      );
    }
    // Every other source is a mechanism the sender chose explicitly (an
    // @mention, a reply, a command) or the display name spelled exactly — none of
    // them has a word that could be excluded without making the bot deaf.
    if (decision.source !== "analyzer") {
      return await noMatch(
        trace,
        `the bot was addressed by ${decision.source ?? "an unrecorded mechanism"}, not by a name the analyzer matched — nothing to exclude`,
        decision.source,
      );
    }
    if (!decision.matchedText) {
      return await noMatch(
        trace,
        "the analyzer verdict on this reply recorded no matched word — nothing to exclude",
        decision.source,
      );
    }
    const displayName = decision.botDisplayName ?? "";
    // Excluding the bot's own name would silence every future summons by name.
    // Mechanical guard on an exact match only — whether some other word IS the
    // name is precisely the judgment the chat is overruling here.
    if (
      displayName &&
      normalizeExclusionTerm(decision.matchedText) === normalizeExclusionTerm(displayName)
    ) {
      return await noMatch(
        trace,
        `the matched word "${decision.matchedText}" is the bot's own display name — excluding it would stop the bot answering to its name`,
        decision.source,
      );
    }

    const { exclusion, created } = await insertAddressingExclusion(db, {
      id: randomUUID(),
      term: decision.matchedText,
      botDisplayName: displayName || decision.matchedText,
      chatId: feedback.chatId,
      telegramMessageId: feedback.telegramMessageId,
      userId: feedback.userId,
      // Transitional: the v1 column FKs the local users_feedbacks table,
      // which the source-store rows can never satisfy since the split. The
      // report's provenance survives in chat/message/user; the v2 core-store
      // schema keeps the plain id with no FK.
      feedbackId: null,
    });
    await trace.event({
      type: "db",
      level: "success",
      message: created
        ? `addressing exclusion recorded: "${exclusion.term}"`
        : `"${exclusion.term}" was already excluded`,
      data: { exclusion, created, botDisplayName: displayName },
    });
    return created
      ? { status: "excluded", exclusion }
      : { status: "already_excluded", exclusion };
  } catch (err) {
    await trace.event({
      type: "error",
      level: "warn",
      message: "could not record the addressing exclusion — the feedback is still stored",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return { status: "no_match", reason: "exclusion could not be recorded" };
  }
}

/** Record why a report produced no exclusion, and report it back. */
async function noMatch(
  trace: TraceRecorder,
  reason: string,
  source: string | null | undefined,
): Promise<AddressingReportOutcome> {
  await trace.event({
    type: "step",
    level: "warn",
    message: "no addressing exclusion recorded",
    data: { reason, source: source ?? null },
  });
  return { status: "no_match", reason, source };
}
