/**
 * The taxonomy of LLM calls the bot makes — the axis Model performance reports on.
 *
 * Why this exists as its own dimension rather than reusing the trace's
 * `feature`/`action`: those describe the *action being traced*, not the call. One
 * handled Telegram message is a single `bot-messaging`/`reply` trace, and it can
 * contain an addressing check, several tool rounds, and a final answer — three kinds
 * of work with completely different cost profiles, previously averaged into one
 * number that moved with the mix rather than with any actual request.
 *
 * Pure and client-safe (`lib/features.ts` is the model): the id is recorded on the
 * trace event, and the UI renders the label, so no raw id is ever shown and no call
 * site invents a display string.
 */

import type { Trace, TraceEvent } from "@/lib/trace";

export const LLM_CALL_KINDS = {
  "addressing-check": {
    id: "addressing-check",
    label: "Addressing check",
    description: "Decides whether an ambiguous group message is talking to the bot.",
  },
  "addressing-verify": {
    id: "addressing-verify",
    label: "Addressing verify",
    description: "Second opinion on the word the addressing check took for the bot's name.",
  },
  "action-claim-check": {
    id: "action-claim-check",
    label: "Honesty gate",
    description:
      "Checks whether a reply that called no tool nevertheless claims something was done.",
  },
  "task-match": {
    id: "task-match",
    label: "Task match",
    description:
      "Decides whether a standing task applies to a message nobody addressed the bot in.",
  },
  // Retired writer (the chat-rules feature merged into tasks, 2026-08-13), kept
  // so traces recorded before the merge still label instead of showing a raw id.
  "chat-rule-match": {
    id: "chat-rule-match",
    label: "Chat rule match",
    description:
      "Decides whether a standing `always` rule applies to a message nobody addressed the bot in.",
  },
  "reply-tool-turn": {
    id: "reply-tool-turn",
    label: "Reply · tool turn",
    description: "One round of a reply's tool loop — the model asked for tools and got results back.",
  },
  "reply-final": {
    id: "reply-final",
    label: "Reply · final answer",
    description: "The round that produced the text sent to the user.",
  },
  "vision-describe": {
    id: "vision-describe",
    label: "Vision · describe image",
    description: "Turns an incoming image into a text description.",
  },
  "voice-transcribe": {
    id: "voice-transcribe",
    label: "Voice · transcribe",
    description: "Turns an incoming voice message into its text transcript.",
  },
  "history-summarize": {
    id: "history-summarize",
    label: "History · summarize",
    description: "Distils a day of conversation into topic summaries.",
  },
  "memory-extract": {
    id: "memory-extract",
    label: "Memory · extract",
    description: "Pulls durable facts out of a batch of messages.",
  },
  "memory-consolidate": {
    id: "memory-consolidate",
    label: "Memory · consolidate",
    description: "Merges and prunes stored memories.",
  },
  "insight-hour": {
    id: "insight-hour",
    label: "Insight · score hour",
    description: "Scores one chat-hour's mood, topic, and word.",
  },
  "insight-rollup": {
    id: "insight-rollup",
    label: "Insight · roll up period",
    description: "Rolls scored hours up into a day/week/month/year/all-time insight.",
  },
  "browser-agent-turn": {
    id: "browser-agent-turn",
    label: "Browser agent · tool turn",
    description: "One round of a browsing run — the agent asked for browser actions and got page state back.",
  },
  "browser-agent-report": {
    id: "browser-agent-report",
    label: "Browser agent · final report",
    description: "The round that produced a browsing run's report.",
  },
  "task-fire": {
    id: "task-fire",
    label: "Task · fire",
    description: "Executes a due timed task — the model decides what, if anything, to send.",
  },
  // Retired writer (scheduled tasks merged into tasks, 2026-08-13), kept so
  // traces recorded before the merge still label instead of showing a raw id.
  "scheduled-task-fire": {
    id: "scheduled-task-fire",
    label: "Scheduled task · fire",
    description: "Generates the message a scheduled task sends.",
  },
  "self-improve-analyze": {
    id: "self-improve-analyze",
    label: "Self-improvement · analyze",
    description: "Proposes a prompt change from accumulated feedback.",
  },
  "self-improve-reflect": {
    id: "self-improve-reflect",
    label: "Self-improvement · reflect",
    description: "Reflects on a single 👍/👎 reaction.",
  },
} as const;

export type LlmCallKindId = keyof typeof LLM_CALL_KINDS;

/** Human label for a call kind, falling back to the raw id for an unknown one. */
export function callKindLabel(id: string): string {
  return (LLM_CALL_KINDS as Record<string, { label: string } | undefined>)[id]?.label ?? id;
}

/**
 * Which kind of call a recorded `llm_response` event was.
 *
 * New events carry the kind explicitly (`usage.callKind`) — that is the whole point
 * of recording it at the call site. The derivation below is for **trace files
 * written before this existed**, and it is exact rather than a catch-all bucket:
 * every feature but two emits exactly one kind of call, and `bot-messaging` already
 * wrote the addressing check and the reply as separately-messaged events.
 *
 * The single imprecision is `analytics-insights`, whose hour-scoring and roll-up
 * passes were indistinguishable in the old traces; those map to `insight-hour`.
 * Acceptable because this same change drops and rebuilds every insight row, so that
 * historic spend produced output that no longer exists, and the split is exact from
 * the next run onward.
 *
 * Returns null when nothing sensible can be said, so the caller can skip rather than
 * invent a category.
 */
export function callKindOf(
  trace: Pick<Trace, "feature" | "action">,
  event: Pick<TraceEvent, "message" | "usage">,
): LlmCallKindId | null {
  const explicit = event.usage?.callKind;
  if (explicit && explicit in LLM_CALL_KINDS) return explicit as LlmCallKindId;

  switch (trace.feature) {
    case "bot-messaging":
      return event.message.includes("addressing analyzer") ? "addressing-check" : "reply-final";
    case "vision":
      return "vision-describe";
    case "voice":
      return "voice-transcribe";
    case "history-summaries":
      return "history-summarize";
    case "memory-extraction":
      return "memory-extract";
    case "memory":
      return "memory-consolidate";
    case "analytics-insights":
      return "insight-hour";
    case "scheduled-tasks":
      return "scheduled-task-fire";
    case "tasks":
      return "task-fire";
    case "browser-agent":
      return "browser-agent-turn";
    case "self-improvement":
      return "self-improve-analyze";
    case "user-feedback":
      return "self-improve-reflect";
    default:
      return null;
  }
}
