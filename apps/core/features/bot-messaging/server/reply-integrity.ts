/**
 * The reply-integrity gate: is what the model produced a REPLY at all?
 *
 * A thinking model is supposed to keep its deliberation in its own channel and
 * send only the answer. This one stops doing that at production prompt scale:
 * measured against the live endpoint on the exact request behind trace
 * `3491c387` (llama.cpp b10588, Huihui-gemma-4-26B-A4B-it-abliterated,
 * 2026-08-24), **10 of 10** replies were the model's raw working-out —
 * transcript echoed back, options weighed, "I'll say X" repeated until the
 * 4096-token cap — with `reasoning_content` empty every time, because the
 * thought channel was never opened. Nothing downstream can tell such an answer
 * from a real one: it is fluent, on topic, and the honesty gate happily passes
 * it. One went out as three Telegram messages.
 *
 * So the turn gets the same shape as the two enforcement checks around it:
 * detect mechanically, retry once with a correction, and suppress rather than
 * send a second failure (user decision, 2026-08-24 — thinking stays ON for
 * replies; leaked thinking is treated as a failed turn).
 *
 * What is checked here is strictly MECHANICAL — the shape of the output, never
 * what it says:
 *
 * - `finish_reason: "length"` — the answer ran into the token cap, so it is
 *   truncated mid-sentence whatever else it is. 7/10 of the measured leaks.
 * - The transcript anchor `[#<id>]` — the input-only line format the system
 *   prompt forbids the model to write ("never write your reply in it"). This
 *   is a format contract, checkable without reading meaning, and it caught
 *   10/10 leaks. The plain `#<id>` citation form stays legal: that is how the
 *   bot links to a message, and only the bracketed anchor is input-only.
 * - Raw channel markers — serving artifacts (`<|channel>` / `<channel|>`) that
 *   are never legitimate reply text. Seen live in a user-facing answer when the
 *   model malformed the sequence and the server could not parse it out.
 *
 * There is deliberately NO lexical rule here — no "starts with 'The user is
 * asking'", no phrase lists. Judging language is the model's job (the honesty
 * gate does it with a citation requirement); code judges facts. Nothing is
 * stripped or rewritten either: a reply either stands as the model wrote it or
 * is regenerated.
 *
 * False-positive check on the same endpoint: 8 ordinary turns (greetings,
 * arithmetic, a joke, a fact, a reminder that called a tool, a thank-you, a
 * request to cite an earlier message) — 0 fired.
 */

/** Which contract the answer broke. */
export type ReplyIntegrityViolation = "truncated" | "transcript_format" | "channel_markers";

export interface ReplyIntegrityVerdict {
  ok: boolean;
  violation?: ReplyIntegrityViolation;
  /** The mechanical evidence, for the trace (never used to alter the text). */
  evidence?: string;
  /** Operator-readable summary of what was wrong. */
  reason?: string;
}

/** The input-only transcript anchor: `[#123]` at the head of a rendered line. */
const TRANSCRIPT_ANCHOR = /\[#\d+\]/;

/** Chat-template channel markers, in the malformed shapes seen live. */
const CHANNEL_MARKER = /<\|channel>|<channel\|>/;

const OK: ReplyIntegrityVerdict = { ok: true };

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
    return {
      ok: false,
      violation: "truncated",
      evidence: `finish_reason "length"`,
      reason: "the answer ran into the token cap and is cut off mid-sentence",
    };
  }
  const anchor = TRANSCRIPT_ANCHOR.exec(input.content);
  if (anchor) {
    return {
      ok: false,
      violation: "transcript_format",
      evidence: anchor[0],
      reason: `the answer is written in the input-only transcript format ("${anchor[0]}") — it is deliberation, not a reply`,
    };
  }
  const marker = CHANNEL_MARKER.exec(input.content);
  if (marker) {
    return {
      ok: false,
      violation: "channel_markers",
      evidence: marker[0],
      reason: `the answer carries raw chat-template markers ("${marker[0]}")`,
    };
  }
  return OK;
}

/**
 * The correction given to a turn that produced deliberation instead of a
 * reply — the second and last attempt at it.
 *
 * Written to name the specific mistake rather than repeat the standing format
 * rules (which were already in the prompt and did not hold): the model is
 * shown its own working-out and told that this is the part nobody may see.
 * Measured on the live endpoint: 10/10 leaked turns produced a clean, short
 * answer on this retry.
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
 * speaking, so it is exempt from the chat's language directive. Silence was
 * the alternative and is worse — the person asked something and is owed the
 * truth that the bot failed, rather than nothing at all.
 */
export const REPLY_NOT_PRODUCED_REPLY =
  "⚠️ System: the bot produced its own notes instead of a reply twice in a row, so nothing was " +
  "sent. Please ask again.";
