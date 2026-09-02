/**
 * The two LLM passes the nightly consolidation job runs, and the parsing of what
 * they return. Pure and client-safe (no DB, no provider) so the whole decision
 * surface of the job is unit-testable without a database or a model.
 *
 * Both scopes are stored as one merged document (operator decision, 2026-07-16),
 * so both passes are a *merge*: existing document + new notes → rewritten
 * document, sharing {@link parseMergedDocument}. They stay two prompts rather than
 * one because they are rewriting genuinely different things — a `user` document is
 * about ONE named person and may say "they"; the `general` document is shared
 * knowledge where every fact must name its own subject.
 *
 * A `general` merge previously reconciled one note at a time (insert / skip /
 * replace) against the stored facts most similar to it, because general knowledge
 * was a set of independently embedded rows. That is gone with the rows.
 */

import { extractJsonObject } from "@/lib/json";

/** Bounds on what may be stored. A note longer than this is rejected at the tool. */
export const MIN_FACT_LENGTH = 2;
export const MAX_FACT_LENGTH = 4_000;

/* --------------------------------------------------- shared durability policy */

/**
 * What "durable" means, as one policy shared by both producers of the pending
 * queue: the `memory_save` tool (the model saving mid-reply) and passive
 * extraction (the nightly job reading the mirror). They are worded for different
 * jobs — one pushes a model to act now, the other harvests a finished day — but
 * they must agree on *what is worth remembering*, or the same sentence would be
 * remembered when the bot was spoken to and dropped when it was not.
 */
export const DURABLE_FACT_KINDS =
  "their name or what they want to be called, where they live or are from, their job or " +
  "studies, their family and pets, a stable preference or taste, a skill, a health constraint, " +
  "a boundary, a recurring plan, or a standing instruction about how they want you to behave";

/** The other half of the policy: what must never reach the queue. */
export const NON_DURABLE_FACT_KINDS =
  "guesses or inferences from vibes, passing moods, jokes, insults, one-off plans, ordinary " +
  "chit-chat, or a value that is merely true right now (the version, model, port, or setting " +
  "someone is running today)";

/**
 * Who a fact about a person may come from. Shared by both producers because a
 * claim's *source* decides whether it is knowledge or gossip, and that cannot
 * depend on which producer happened to hear it.
 *
 * Hearsay is what put "worked at big companies like LastPass" into general
 * knowledge: one person speculating about a third party, in a chat where the
 * subject never said any such thing. A confident sentence about someone else is
 * still the speaker's belief, and storing it as fact laundres a guess into memory.
 */
export const FIRST_PERSON_EVIDENCE_RULE =
  "only store a fact about a person when THAT PERSON stated it about themselves, or explicitly " +
  "confirmed it about themselves — what someone says about somebody else is hearsay (they may be " +
  "guessing, exaggerating, or joking) and must not be stored, however confident it sounds";

/**
 * What to do with a fact about someone who cannot be resolved to a known-user id
 * (operator decision, 2026-07-28): keep it as `general` knowledge, with their name
 * written into the sentence.
 *
 * This reverses the 2026-07-17 decision to *drop* such a fact. Dropping was aimed
 * at a real failure — general knowledge has no identity model, so name-keyed lines
 * about different people were being merged into one subject — but it also silently
 * destroyed facts the bot had just been told to remember, about people who are
 * talked about in a group and will never be members of it. Those people are
 * exactly what shared knowledge is for.
 *
 * Two guards replace the ban, so the old failure does not come back:
 *  - the identity model moved to the *gate*, not the document: a fact about someone
 *    the bot **can** identify is refused under `general` and must be filed under
 *    them (see `checkGeneralNoteSubject`), so `general` only ever holds outsiders.
 *  - {@link GENERAL_MERGE_PROMPT} forbids merging two lines about people into one
 *    subject, which is how one name used to absorb another.
 */
export const UNIDENTIFIED_PERSON_RULE =
  "a person you cannot match to a known id cannot have a fact filed under them, but the fact is " +
  "not lost: save it as 'general' knowledge with their name written into the sentence, so it is " +
  "still known without pretending to be about someone you can identify — never invent an id, and " +
  "never guess which known person was meant";

/** How a stored fact must be written, so it survives losing its conversation. */
export const SELF_CONTAINED_FACT_RULE =
  "write each as a single self-contained sentence that will still make sense to someone reading " +
  "it months later with no memory of this conversation (include the who and the what, not 'he " +
  "said yes')";

/* ------------------------------------------------------------------ user doc */

/** System prompt for the per-user document merge. */
export const USER_MERGE_PROMPT =
  "You maintain the long-term memory document a chat bot keeps about ONE person. " +
  "You are given the current document and newly saved facts about that same person. Rewrite the " +
  "document to incorporate the new facts.\n" +
  "Rules:\n" +
  "- Preserve every unique durable detail. This is lossless except where a fact is a duplicate, " +
  "is contradicted, or was never durable.\n" +
  "- Drop duplicates and near-duplicates: if a new fact restates something already there in " +
  "different words, keep one concise version.\n" +
  "- When a new fact contradicts an old one, keep the new one and drop the outdated line — people " +
  "move, change jobs, and change their minds.\n" +
  "- Write one fact per line, no bullet characters, no section headers, no preamble.\n" +
  "- Order loosely: identity and background first, then how they communicate, then what they like, " +
  "then what they dislike or want you to avoid.\n" +
  "- Never invent a fact that is not in the inputs.\n" +
  'Reply with ONLY a JSON object of the shape {"memory": string} — the whole document as one ' +
  'string with newline-separated facts. Use {"memory": ""} if nothing durable remains.';

export interface UserMergeInput {
  /** Human label of the person, so the document reads about someone rather than "the user". */
  label: string;
  /** The current document's facts (empty for a person with no memory yet). */
  existing: string[];
  /** The pending notes to fold in. */
  incoming: string[];
}

/** Build the user-document merge request (the user turn; system prompt is separate). */
export function buildUserMergeRequest(input: UserMergeInput): string {
  const existing = input.existing.length > 0 ? input.existing.join("\n") : "(nothing known yet)";
  const incoming = input.incoming.map((fact) => `- ${fact}`).join("\n");
  return [
    `The person this document is about: ${input.label}.`,
    "",
    "Current memory document:",
    existing,
    "",
    "Newly saved facts to fold in:",
    incoming,
  ].join("\n");
}

/**
 * The merged document the model returned, normalized to fact lines. Empty array
 * when the model reported nothing durable (or returned something unusable) —
 * callers treat an empty result as "leave the existing document alone" rather
 * than as "erase this person", so a bad model response can never destroy memory.
 */
export function parseMergedDocument(content: string): string[] {
  const obj = extractJsonObject(content);
  const raw = typeof obj?.memory === "string" ? obj.memory : null;
  if (raw == null) return [];
  return raw
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length >= MIN_FACT_LENGTH && !/^none$/i.test(line));
}

/* ----------------------------------------------------------------- general */

/** System prompt for the general-knowledge document merge. */
export const GENERAL_MERGE_PROMPT =
  "You maintain the long-term memory document a chat bot keeps of GENERAL knowledge — " +
  "shared facts, definitions, rules and conventions, and how things work. You are given the " +
  "current document and newly saved facts. Rewrite the document to incorporate the new facts.\n" +
  "Rules:\n" +
  "- This document holds two kinds of fact: knowledge that is about nobody, and facts about " +
  "people who have no document of their own — someone talked about in chat who is not in it. " +
  "Both belong here. Keep every named fact: a fact only reaches this document once it has been " +
  "decided that its subject has nowhere else to live, so dropping a person's line here loses it " +
  "for good.\n" +
  "- Never merge two lines about people into one subject, and never conclude that two names are " +
  "the same person. You have no way to tell, and guessing wrong invents a person.\n" +
  "- Preserve every unique durable detail. This is lossless except where a fact is a duplicate, " +
  "is contradicted, or was never durable.\n" +
  "- Drop duplicates and near-duplicates: if a new fact restates something already there in " +
  "different words, keep one concise version.\n" +
  "- When a new fact contradicts an old one, keep the new one and drop the outdated line — " +
  "arrangements change and facts get corrected.\n" +
  "- Every line must name its own subject and stand on its own: this document is read with no " +
  "conversation around it, so never write 'he', 'they', or 'the above'. A fact about a person " +
  "must name that person.\n" +
  "- Write one fact per line, no bullet characters, no section headers, no preamble.\n" +
  "- Group related facts near each other so the document stays readable as it grows.\n" +
  "- Never invent a fact that is not in the inputs.\n" +
  'Reply with ONLY a JSON object of the shape {"memory": string} — the whole document as one ' +
  'string with newline-separated facts. Use {"memory": ""} if nothing durable remains.';

export interface GeneralMergeInput {
  /** The current document's facts (empty for a store with nothing in it yet). */
  existing: string[];
  /** The pending notes to fold in. */
  incoming: string[];
}

/** Build the general-document merge request (the user turn; system prompt is separate). */
export function buildGeneralMergeRequest(input: GeneralMergeInput): string {
  const existing = input.existing.length > 0 ? input.existing.join("\n") : "(nothing known yet)";
  const incoming = input.incoming.map((fact) => `- ${fact}`).join("\n");
  return [
    "Current general knowledge document:",
    existing,
    "",
    "Newly saved facts to fold in:",
    incoming,
  ].join("\n");
}
