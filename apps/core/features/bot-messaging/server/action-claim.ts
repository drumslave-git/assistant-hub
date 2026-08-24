import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

/**
 * The honesty gate: does a reply that called no tool nevertheless tell the user
 * something was done?
 *
 * The base system prompt's Honesty block already forbids exactly this in five
 * separate rules, including the one this failure walks straight through
 * ("Someone asking you the same thing again is telling you it did not take
 * effect"). A 12B local model reads them and does it anyway. Measured live
 * (2026-08-06, trace `3db16957…`): asked twice in a row to cancel a scheduled
 * task, the model spent ~2,900 reasoning tokens listing `rules_list` as step one
 * of its plan four separate times, talked itself out of it — *"if I find no rule
 * in `rules_list`, I won't call the tool because there is nothing to delete"* —
 * and answered, in effect, "removed from the record". Nothing was removed, and
 * the turn before it had lied the same way.
 *
 * So this is not more standing prompt text. It is a check on the drafted answer,
 * run only when the whole turn made **zero** tool calls, and the correction is
 * shown only after the lie exists, with the lie in front of it — the one form of
 * the instruction the model has not already ignored this turn. Same shape and
 * same reasoning as the task-turn enforcement in `features/tasks/format.ts`,
 * which was written against the same failure on a narrower path.
 *
 * Why an LLM and not a word list: "was anything asserted as done" is a question
 * about language, and language judgment belongs to the model. Code judges only
 * mechanical facts — did any tool run (counted in the service), and does the
 * model's citation actually occur in the reply.
 *
 * The classifier commits to a bounded enum *and* must quote the words that carry
 * the claim, verbatim. The enum alone is not enough with a weak model: without a
 * citation requirement it will stamp a verdict on the general shape of a reply
 * rather than on anything in it. A verdict whose quote is not really in the
 * reply is discarded.
 *
 * Fails **open**, unlike the addressing analyzer. An unreadable verdict here
 * means the guard abstains and the reply goes out as written — the alternative
 * is a provider hiccup silently forcing every ordinary turn through a needless
 * second generation. This guard removes lies; it must not become a new way for
 * turns to break.
 *
 * Scope: zero-tool turns only. A reply that called `tasks_list` and then lied
 * about what the result said is a different failure, and one the mechanical
 * signal cannot see.
 *
 * The one hard case, found on the first day live (2026-08-07, trace
 * `ab4fc127…`): asked to stop bringing a topic up, the bot agreed — "crossing
 * it off the repertoire". That is a promise about how it will *talk*, and
 * talking is the one thing it does without a tool, so it is honest. The
 * classifier could not settle it: it spent its whole token budget on a
 * two-sentence reply, produced no verdict, and the gate abstained after 40
 * seconds. Hence the explicit bullet for it in the prompt — left ambiguous, the
 * likelier answer was "promised", which would have retried and then suppressed a
 * perfectly honest reply. The budget it overran is set by the caller, small on
 * purpose: a verdict that needs more thinking than this question deserves is one
 * this guard is better off not having (see the caps in `process-update.ts`).
 */

/** What, if anything, the reply asserts about an action of the assistant's own. */
export const ACTION_CLAIM_VALUES = ["performed", "promised", "none"] as const;

export type ActionClaim = (typeof ACTION_CLAIM_VALUES)[number];

export const ACTION_CLAIM_SYSTEM_PROMPT = `You check one chat reply for a single thing: does it tell the user that the assistant DID something, or WILL do something, beyond writing the reply itself?

The assistant can only affect anything by calling a tool. On the turn you are checking it called no tool at all, so any such statement in the reply is false. You are not judging whether the reply is good, polite, in character, or helpful — only whether it makes such a statement.

The conversation before this turn may be provided. It shows what was actually said in the chat; lines from "You" are the assistant's own earlier messages. Use it to tell speech about the conversation apart from action claims.

Classify the reply:
- "performed" — it states or implies the action already happened: something was deleted, cancelled, saved, created, scheduled, sent, downloaded, looked up, checked, read, or remembered.
- "promised" — it states the action will happen later, or that the assistant is doing it now: a reminder that will fire, a task that will run, a thing it is "about to" do.
- "none" — it makes no such statement.

Answer "none" when the reply:
- only answers, explains, jokes, argues, or gives an opinion
- says the assistant cannot do something, does not know, or could not find something
- offers to do something, or asks whether it should ("I can cancel it if you want" is an offer, not a claim)
- describes what someone ELSE did, or what happened earlier in the conversation
- speaks about its own earlier messages — that it already told, said, answered, explained, mentioned, or repeated something. Talking is never an action ("I've already told you" claims nothing), and the conversation shows what was really said
- describes a capability in general terms without asserting it was used
- only says how it will talk or behave in later messages — that it will stop bringing something up, drop a topic, be shorter, change its tone. Writing and not writing are both just writing, so agreeing to say less claims nothing. This holds however the reply phrases it, including as something being struck off, dropped, closed, or put aside.

Read the request too: it tells you what action was at stake. But judge the REPLY — a request to do something does not by itself make the reply a claim.

For "performed" or "promised", copy the words of the reply that carry the claim into "quote" — verbatim, character for character, exactly as they appear in the reply, in the reply's own language. Do not translate them and do not tidy them up. If you cannot point to such words, the answer is "none" and "quote" is null.

Reply with ONLY a JSON object of the shape {"claim": "performed" | "promised" | "none", "quote": "<verbatim words from the reply>" | null} — no code fences, no commentary.`;

export interface ActionClaimInput {
  /** The message the reply answers, as the reply model was shown it. */
  request: string;
  /** The drafted reply, exactly as it would be sent. */
  reply: string;
  /**
   * The same conversation window the reply model saw (the rendered
   * transcript message), or null when the turn had none. Without it the
   * gate read "I've already told you" — plain speech about the chat — as a
   * fabricated action and suppressed an honest answer (user decision,
   * 2026-08-24: the gate judges with the reply's own context).
   */
  transcript: string | null;
}

/** The messages for one honesty-gate call: the fixed rules, then this turn. */
export function buildActionClaimMessages(input: ActionClaimInput): ChatMessage[] {
  const transcript = input.transcript?.trim();
  return [
    { role: "system", content: ACTION_CLAIM_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        (transcript ? `Conversation before this turn:\n${transcript}\n\n` : "") +
        `Request:\n${input.request.trim()}\n\n` +
        `Reply to check:\n${input.reply.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface ActionClaimVerdict {
  /** True only when a claim was readably asserted AND its citation checks out. */
  claimsAction: boolean;
  /** The classification the model committed to, or null when it emitted none. */
  claim: ActionClaim | null;
  /** The words the model cited as carrying the claim, when it cited any. */
  quote: string | null;
  reason: string;
}

/**
 * Read the classifier's verdict. Fails open — see the module note: anything we
 * cannot understand, and anything the model could not back with a real quote
 * from the reply, means the guard abstains and the reply stands.
 */
export function parseActionClaimVerdict(
  content: string,
  context: { reply: string },
): ActionClaimVerdict {
  const parsed = extractJsonObject(content);
  const raw = parsed?.claim;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!value || !ACTION_CLAIM_VALUES.includes(value as ActionClaim)) {
    return {
      claimsAction: false,
      claim: null,
      quote: null,
      reason: "unreadable honesty-gate answer — reply left as written",
    };
  }
  const claim = value as ActionClaim;
  if (claim === "none") {
    return { claimsAction: false, claim, quote: null, reason: "reply claims no action" };
  }

  const citedRaw = parsed?.quote;
  const cited = typeof citedRaw === "string" ? citedRaw.trim() : "";
  if (!cited) {
    return {
      claimsAction: false,
      claim,
      quote: null,
      reason: `"${claim}" claimed without quoting the reply — reply left as written`,
    };
  }
  if (!context.reply.toLowerCase().includes(cited.toLowerCase())) {
    return {
      claimsAction: false,
      claim,
      quote: cited,
      reason: `quoted claim "${cited}" does not occur in the reply — reply left as written`,
    };
  }
  return {
    claimsAction: true,
    claim,
    quote: cited,
    reason:
      claim === "performed"
        ? `reply states the action was done ("${cited}") but no tool was called`
        : `reply promises the action ("${cited}") but no tool was called`,
  };
}

/**
 * The correction given to a turn whose answer claimed an action no tool
 * performed — the second and last attempt at it.
 *
 * The third bullet is the specific lever for the failure this was written
 * against: the model declined to call a *read* tool because it had already
 * guessed the read would come back empty, and then reported the guess as a
 * result. Naming that as the mistake, rather than repeating "call a tool", is
 * what the standing prompt cannot do.
 *
 * Like the rule-turn directive, it offers the honest answer as an equal option.
 * A model cornered into calling *something* picks a wrong tool, and "I did not
 * do it" is a correct answer here.
 */
export const ACTION_CLAIM_ENFORCEMENT_DIRECTIVE =
  "STOP. The answer you just gave called no tool at all, so nothing happened — you only wrote that " +
  "it did. That message will not be sent as it stands.\n\n" +
  "Answer once more, and pick one of exactly two things:\n" +
  "- Carry the action out now, by calling the tool that performs it. Do not describe the call, do " +
  "not say you are about to make it, do not report a result you do not have — make the call.\n" +
  "- Or reply saying plainly that you did not do it, and why. That is an honest answer and an " +
  "acceptable one.\n\n" +
  "If you do not know whether the thing exists — the task, the rule, the record — read it with the " +
  "tool that reads it, in this turn. Guessing that a lookup would find nothing, and then answering " +
  "from the guess, is exactly what went wrong a moment ago: a lookup you did not run has no result, " +
  "and a repeated request from the user is evidence that the thing is still there.\n\n" +
  "Repeating your previous answer, or any other claim that the action happened, is not among your " +
  "options.";

/**
 * Sent in place of an answer that claimed an action no tool performed, twice
 * over. Same labeled-system form as the feature's other notices: it is the
 * infrastructure reporting a fault, not the persona speaking, so it is exempt
 * from the chat's language directive and cannot be mistaken for the bot's own
 * voice.
 */
export const ACTION_NOT_TAKEN_REPLY =
  "⚠️ System: the reply to this message claimed something had been done that was not done, so it " +
  "was not sent. Nothing was changed. Please ask again, or say exactly what you want done.";
