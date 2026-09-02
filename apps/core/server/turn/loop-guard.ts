import "server-only";

import type { HistoryMessage, InboundMessageEvent } from "@assistant-hub-swarm/contracts";

/**
 * The bot-to-bot loop guard (PLAN "Shared-chat behavior"; user decision,
 * 2026-08-24 — N defaults to 3). Assistants sharing a chat hear each other
 * through the source's cross-feed, so nothing in Telegram stops two of them
 * from answering each other forever. This does: once a chat holds N
 * assistant-authored messages in a row, every assistant there stays silent
 * until a human speaks again.
 *
 * Deterministic on purpose — no LLM, no judgement about whether the exchange
 * is "still useful". The streak is read straight off the conversation window
 * the source composed, which is the same evidence the chat itself shows.
 *
 * Only a cross-fed turn can be stopped by it: a turn opened by a human
 * message has that message at the tail of the streak, which is precisely the
 * "until a human speaks" reset.
 */

/**
 * How many assistant-authored messages the chat ends with, counting the
 * incoming one. Zero for a message a person wrote.
 *
 * The window excludes the current message (the source composes it that way),
 * so the trailing run is counted in history and the incoming message adds
 * itself.
 */
export function assistantTurnStreak(
  history: readonly HistoryMessage[],
  incomingIsAssistant: boolean,
): number {
  if (!incomingIsAssistant) return 0;
  let streak = 1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "assistant") break;
    streak += 1;
  }
  return streak;
}

/** What the guard decided, and why — recorded verbatim on the turn's trace. */
export interface LoopGuardVerdict {
  /** True when this turn must not run: the chat is at (or past) the limit. */
  silenced: boolean;
  /** Assistant messages the chat ends with, including this one. */
  streak: number;
  /** The configured limit the streak was judged against. */
  limit: number;
  reason: string;
}

/** Judge one inbound event against the configured limit. */
export function checkLoopGuard(event: InboundMessageEvent, limit: number): LoopGuardVerdict {
  const streak = assistantTurnStreak(
    event.context.history,
    Boolean(event.authoredByAssistantId),
  );
  if (streak === 0) {
    return { silenced: false, streak, limit, reason: "a person wrote this message" };
  }
  if (streak >= limit) {
    return {
      silenced: true,
      streak,
      limit,
      reason:
        limit === 0
          ? "assistants are configured not to answer each other"
          : `${streak} assistant messages in a row (limit ${limit}) — silent until someone speaks`,
    };
  }
  return {
    silenced: false,
    streak,
    limit,
    reason: `${streak} of ${limit} assistant messages in a row`,
  };
}
