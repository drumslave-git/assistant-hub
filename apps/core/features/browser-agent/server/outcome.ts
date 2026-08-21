import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

/**
 * The run-outcome verdict: does the agent's final report say the goal was
 * accomplished, or that it failed?
 *
 * The runner used to settle every run that produced a report as `done` —
 * `failed` was reserved for thrown errors (provider down, crash). But the agent
 * is *instructed* to end an unachievable goal with an honest failure report, so
 * the dashboard showed "Done" on runs whose own report says the download never
 * happened (operator report, 2026-08-12). The failure verdict lives in the
 * report's language, and language judgment belongs to the model — code judges
 * only the mechanical facts: the enum it committed to, and whether its citation
 * actually occurs in the report. Same shape, same reasoning, and same
 * fail-open stance as the reply path's honesty gate (`action-claim.ts`): an
 * unreadable verdict, or one whose quote is not really in the report, means the
 * gate abstains and the run settles `done` exactly as before — this check
 * reclassifies failures, it must not invent them.
 */

/** What the report says about the goal. */
export const RUN_OUTCOME_VALUES = ["achieved", "failed", "unclear"] as const;

export type RunOutcome = (typeof RUN_OUTCOME_VALUES)[number];

export const RUN_OUTCOME_SYSTEM_PROMPT = `You check the final report of a web-browsing agent for a single thing: does it say the goal was accomplished, or that it was not?

You are given the goal the agent was sent to do and the report it came back with. You are not judging whether the report is well written, polite, or detailed — only what outcome it states for the MAIN thing the goal asks for.

Classify the report:
- "achieved" — it states the goal's outcome was delivered: the thing was found, read, answered, downloaded, or done.
- "failed" — it states the goal was NOT accomplished: the thing could not be found, reached, or downloaded; an error stopped the work; every attempt it describes failed; or it only tells the user what to do instead of delivering a result.
- "unclear" — the report does not readably state either.

A report that delivers the main outcome while noting some side detail failed is "achieved". A report that apologizes, explains what went wrong, or reports the attempts and their errors is "failed" even when it is helpful and polite about it.

For "failed", copy the words of the report that state the failure into "quote" — verbatim, character for character, exactly as they appear in the report, in the report's own language. Do not translate them and do not tidy them up. If you cannot point to such words, the answer is "unclear" and "quote" is null.

Reply with ONLY a JSON object of the shape {"outcome": "achieved" | "failed" | "unclear", "quote": "<verbatim words from the report>" | null} — no code fences, no commentary.`;

export interface RunOutcomeInput {
  /** The goal the run was enqueued with. */
  goal: string;
  /** The agent's final report, exactly as delivered. */
  report: string;
}

/** The messages for one outcome check: the fixed rules, then this run. */
export function buildRunOutcomeMessages(input: RunOutcomeInput): ChatMessage[] {
  return [
    { role: "system", content: RUN_OUTCOME_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Goal:\n${input.goal.trim()}\n\n` +
        `Report to check:\n${input.report.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface RunOutcomeVerdict {
  /** True only when failure was readably asserted AND its citation checks out. */
  goalFailed: boolean;
  /** The classification the model committed to, or null when it emitted none. */
  outcome: RunOutcome | null;
  /** The words the model cited as stating the failure, when it cited any. */
  quote: string | null;
  reason: string;
}

/**
 * Read the classifier's verdict. Fails open — see the module note: anything we
 * cannot understand, and any "failed" the model could not back with a real
 * quote from the report, means the gate abstains and the run settles done.
 */
export function parseRunOutcomeVerdict(
  content: string,
  context: { report: string },
): RunOutcomeVerdict {
  const parsed = extractJsonObject(content);
  const raw = parsed?.outcome;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!value || !RUN_OUTCOME_VALUES.includes(value as RunOutcome)) {
    return {
      goalFailed: false,
      outcome: null,
      quote: null,
      reason: "unreadable outcome-check answer — run settles as done",
    };
  }
  const outcome = value as RunOutcome;
  if (outcome !== "failed") {
    return {
      goalFailed: false,
      outcome,
      quote: null,
      reason: outcome === "achieved" ? "report states the goal was achieved" : "outcome unclear",
    };
  }

  const citedRaw = parsed?.quote;
  const cited = typeof citedRaw === "string" ? citedRaw.trim() : "";
  if (!cited) {
    return {
      goalFailed: false,
      outcome,
      quote: null,
      reason: '"failed" claimed without quoting the report — run settles as done',
    };
  }
  if (!context.report.toLowerCase().includes(cited.toLowerCase())) {
    return {
      goalFailed: false,
      outcome,
      quote: cited,
      reason: `quoted failure "${cited}" does not occur in the report — run settles as done`,
    };
  }
  return {
    goalFailed: true,
    outcome,
    quote: cited,
    reason: `the report states the goal failed ("${cited}")`,
  };
}
