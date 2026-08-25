/**
 * Is what the model produced a REPLY at all?
 *
 * A thinking model is supposed to keep its working-out in its own channel and
 * send only the answer. This one stops doing that at production prompt scale:
 * measured against the live endpoint on the exact request behind trace
 * `3491c387` (llama.cpp b10588, gemma-4-26B-A4B-it-abliterated, 2026-08-24),
 * **10 of 10** replies were raw deliberation — the transcript echoed back,
 * options weighed, "I'll say X" repeated — with the thought channel never
 * opened, so the server had nothing to strip. One went out as three Telegram
 * messages. Nothing downstream can tell such an answer from a real one.
 *
 * Two rules, both mechanical — the shape of the output, never what it says:
 *
 * 1. It ran into the token cap, so it is cut off mid-sentence whatever else it
 *    is. Reason enough on its own; it is also what 7 of those 10 did.
 * 2. It contains text a reply may never contain: the `[#<id>]` transcript
 *    anchor, which is the input-only line format the system prompt forbids the
 *    model to write, or a raw chat-template channel marker, which is a serving
 *    artifact. All 10 leaks carried the anchor — including the 3 that ended
 *    inside the cap and rule 1 would have sent.
 *
 * The plain `#<id>` citation form stays legal: that is how the bot links to a
 * message. Only the bracketed anchor is input-only.
 *
 * Deliberately no lexical rule — no "starts with 'The user is asking'", no
 * phrase lists. Judging language is the model's job (the honesty gate does it,
 * with a citation requirement); code judges facts. Nothing is stripped or
 * rewritten either: a reply either stands as the model wrote it, or the turn
 * asks for another one.
 *
 * False-positive check on the same endpoint: 8 ordinary turns (greetings,
 * arithmetic, a joke, a fact, a reminder that called a tool, a thank-you, a
 * request to cite an earlier message) — none fired.
 */

/**
 * Text that is never part of a reply: the input-only transcript anchor
 * (`[#123]`), and the chat template's channel markers in the malformed shapes
 * seen live.
 */
const NEVER_IN_A_REPLY = /\[#\d+\]|<\|channel>|<channel\|>/;

/** `reason` is set only when the answer is rejected. */
export interface ReplyIntegrityVerdict {
  ok: boolean;
  /** What was wrong, quoting the evidence — for the trace and nothing else. */
  reason?: string;
}

/**
 * Judge one drafted reply. `finishReason` is the provider's own word for how
 * generation ended (`finishReasonOf(responseBody)`); an absent one is treated
 * as normal, since a provider that reports nothing cannot report truncation.
 */
export function checkReplyIntegrity(input: {
  content: string;
  finishReason?: string;
}): ReplyIntegrityVerdict {
  if (input.finishReason === "length") {
    return { ok: false, reason: "the answer ran into the token cap and is cut off mid-sentence" };
  }
  const found = NEVER_IN_A_REPLY.exec(input.content);
  if (found) {
    return {
      ok: false,
      reason: `the answer contains "${found[0]}", which belongs to the transcript the model is GIVEN, not to a reply — it is deliberation`,
    };
  }
  return { ok: true };
}

/**
 * The correction given to a turn that produced deliberation instead of a
 * reply — the second and last attempt at it.
 *
 * Names the specific mistake rather than repeating the standing format rules
 * (which were already in the prompt and did not hold): the model is shown its
 * own working-out and told that this is the part nobody may see. Measured on
 * the live endpoint: 10/10 leaked turns produced a clean, short answer on this
 * retry.
 */
export const REPLY_INTEGRITY_DIRECTIVE =
  "STOP. What you just produced is your own working-out — the weighing of options you do BEFORE " +
  "answering — not an answer. Nobody in this chat may see that, and it will not be sent.\n\n" +
  "Write the reply itself now: only the words you would say out loud to the person, in your own " +
  "voice.\n\n" +
  "Not any of this:\n" +
  "- the transcript line format (`[#123] someone: …`) — that is how you are GIVEN the conversation, " +
  "never how you write in it\n" +
  "- restating or translating the message you are answering\n" +
  "- narrating what you should do, listing what you could say, or choosing between drafts\n" +
  "- talking about your instructions, your persona, or yourself in the third person\n\n" +
  "If the answer is one short sentence, send one short sentence.";

/**
 * Sent when a second attempt is deliberation as well. Same labeled-system form
 * as the other notices: infrastructure reporting a fault, not the persona
 * speaking, so it is exempt from the chat's language directive. Silence was the
 * alternative and is worse — the person asked something and is owed the truth
 * that the bot failed, rather than nothing at all.
 */
export const REPLY_NOT_PRODUCED_REPLY =
  "⚠️ System: the bot produced its own notes instead of a reply twice in a row, so nothing was " +
  "sent. Please ask again.";
