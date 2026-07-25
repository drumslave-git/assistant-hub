import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

import type { BotIdentity } from "./addressing";

/**
 * The LLM half of the addressing check: does this group message call the bot by
 * name in a form a literal match cannot see — the same name in another alphabet,
 * or an inflected/vocative form?
 *
 * Prompt building and parsing are pure, so the whole decision is unit-testable
 * without a provider. The caller (the bot-messaging service) owns the completion
 * and the trace; this module owns what is asked and how the answer is read.
 *
 * The model classifies *how* the name appears instead of answering yes/no. A
 * bounded enum makes it commit to a conclusion that the decision is then derived
 * from in code, so a hedging or chatty model cannot talk its way into a reply —
 * and "absent" stays a specific, checkable answer rather than a shade of no.
 *
 * The enum alone is not enough against a weak model: a small local model was
 * observed stamping "other_alphabet" on *every* Cyrillic message — it judged the
 * language of the message, not the name. So a non-"absent" answer must also cite
 * the word it took for the name (`matched_text`), and the verdict only counts
 * when that citation actually occurs in the message. Whether the cited word IS
 * the name stays the model's judgment — code checks only what is mechanical
 * (the quote is real), never linguistics.
 *
 * Even a real citation can still be the wrong word: the same model cited "бота"
 * — the generic word "bot", declined — as a match for a display name it plainly
 * is not. So a surviving citation goes back to the model as its own focused
 * question (see {@link buildVerifierMessages}): identify the word's base form
 * and what it refers to, then say whether it is the display name. Naming the
 * base form first is what makes the weak model notice that a declined generic
 * word is not a name. Both calls fail closed — no readable confirmation, no
 * reply.
 */

/** How the display name appears in the message. Anything but `absent` replies. */
export const NAME_MATCH_VALUES = ["exact", "other_alphabet", "inflected", "absent"] as const;

export type NameMatch = (typeof NAME_MATCH_VALUES)[number];

export const ANALYZER_SYSTEM_PROMPT = `You decide whether a group-chat message calls a Telegram bot by its display name.

@username mentions, replies to the bot, and slash commands are already handled elsewhere — judge only the spoken display name. An automated scan has already looked for the name spelled exactly as configured and found nothing, but it can only catch that exact spelling: it misses other alphabets, transliterations, and inflected forms. Judge the message yourself.

Classify how the display name appears:
- "exact" — the name, or a clear spelling/case variation of it
- "other_alphabet" — the same name written in another language or alphabet (for example a Cyrillic spelling of a Latin name)
- "inflected" — a vocative or otherwise declined grammatical form of the name (many languages inflect a name when addressing someone)
- "absent" — the name is not there

Answer "absent" when:
- The display name does not appear and is not clearly referenced
- People are talking among themselves; a second-person "you" alone is not the bot's name
- Generic words like "bot", "assistant", or "AI" appear without the specific display name
- It is background chatter the bot should not interrupt
- The message is merely written in another language or alphabet than the name: that by itself does not put the name into the message — classify the name, not the language

For any answer other than "absent", copy the word of the message you take for the bot's name into "matched_text" — verbatim, character for character, exactly as it appears in the message. If you cannot point to such a word, the answer is "absent" and "matched_text" is null.

Reply with ONLY a JSON object of the shape {"name_match": "exact" | "other_alphabet" | "inflected" | "absent", "matched_text": "<verbatim word from the message>" | null} — no code fences, no commentary.`;

export interface AnalyzerInput {
  bot: BotIdentity;
  chatType: string;
  /** The message's user text (body or caption). */
  text: string;
}

/** The messages for one analyzer call: the fixed rules, then this message. */
export function buildAnalyzerMessages(input: AnalyzerInput): ChatMessage[] {
  return [
    { role: "system", content: ANALYZER_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Bot display name: ${input.bot.displayName.trim()}\n` +
        `Bot username: @${input.bot.username.replace(/^@/, "")}\n` +
        `Chat type: ${input.chatType}\n\n` +
        `Message:\n${input.text.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface AnalyzerVerdict {
  addressed: boolean;
  /** The classification the model committed to, or null when it emitted none. */
  nameMatch: NameMatch | null;
  /** The word the model cited as the name, when it cited one. */
  matchedText: string | null;
  reason: string;
}

/** What the citation check compares the model's answer against. */
export interface AnalyzerVerdictContext {
  /** The message text the analyzer was shown (body, caption, or transcript). */
  text: string;
}

/**
 * Read the model's classification and derive the decision from it. An answer we
 * cannot understand is a "no": the bot stays out of a conversation it was never
 * shown to be part of. A "yes" only counts when the model's own citation checks
 * out — the cited word must occur verbatim in the message (see the module
 * comment for the failure mode this guards against).
 */
export function parseAnalyzerVerdict(
  content: string,
  context: AnalyzerVerdictContext,
): AnalyzerVerdict {
  const parsed = extractJsonObject(content);
  const raw = parsed?.name_match;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!value || !NAME_MATCH_VALUES.includes(value as NameMatch)) {
    return { addressed: false, nameMatch: null, matchedText: null, reason: "unreadable analyzer answer" };
  }
  const nameMatch = value as NameMatch;
  if (nameMatch === "absent") {
    return { addressed: false, nameMatch, matchedText: null, reason: "display name absent" };
  }

  const citedRaw = parsed?.matched_text;
  const cited = typeof citedRaw === "string" ? citedRaw.trim() : "";
  if (!cited) {
    return {
      addressed: false,
      nameMatch,
      matchedText: null,
      reason: `"${nameMatch}" claimed without citing the matched word — treated as absent`,
    };
  }
  if (!context.text.toLowerCase().includes(cited.toLowerCase())) {
    return {
      addressed: false,
      nameMatch,
      matchedText: cited,
      reason: `cited match "${cited}" does not occur in the message — treated as absent`,
    };
  }
  return {
    addressed: true,
    nameMatch,
    matchedText: cited,
    reason: `display name appears as ${nameMatch} ("${cited}")`,
  };
}

export const VERIFIER_SYSTEM_PROMPT = `You verify one word against a Telegram bot's display name.

You are given the bot's display name and a single word taken from a chat message. First identify what the word actually is: give its base (dictionary) form and say what it refers to. Then decide whether it IS the display name — the same name, possibly written in another alphabet (for example a Cyrillic spelling of a Latin name) or in an inflected/declined grammatical form.

It is NOT the display name when it is:
- a different person's name
- a generic word like "bot", "assistant", or "AI" in any language, in any grammatical form
- an ordinary word of the sentence that is not a name at all

Reply with ONLY a JSON object of the shape {"base_form": "<the word's base form>", "refers_to": "<what it names or means>", "is_display_name": true | false} — no code fences, no commentary.`;

/** The messages for one verifier call: the fixed rules, then the cited word. */
export function buildVerifierMessages(bot: BotIdentity, citedText: string): ChatMessage[] {
  return [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Bot display name: ${bot.displayName.trim()}\n` +
        `Word from the message: ${citedText.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface VerifierVerdict {
  /** True only when the model readably confirmed the word is the display name. */
  isDisplayName: boolean;
  reason: string;
}

/**
 * Read the verifier's confirmation. Fail closed: anything but a readable
 * `"is_display_name": true` means the cited word did not survive scrutiny and
 * the message reads as not addressed.
 */
export function parseVerifierVerdict(content: string, citedText: string): VerifierVerdict {
  const parsed = extractJsonObject(content);
  const confirmed = parsed?.is_display_name;
  if (typeof confirmed !== "boolean") {
    return { isDisplayName: false, reason: "unreadable verifier answer — treated as absent" };
  }
  if (!confirmed) {
    const refersTo = typeof parsed?.refers_to === "string" ? ` (${parsed.refers_to})` : "";
    return {
      isDisplayName: false,
      reason: `cited match "${citedText}" is not the display name${refersTo} — treated as absent`,
    };
  }
  return { isDisplayName: true, reason: `verifier confirmed "${citedText}" as the display name` };
}
