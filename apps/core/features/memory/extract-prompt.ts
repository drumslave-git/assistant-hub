import type { SummarizableMessage } from "@/features/history/summary";
import { extractJsonObject } from "@/lib/json";

import {
  DURABLE_FACT_KINDS,
  FIRST_PERSON_EVIDENCE_RULE,
  MAX_FACT_LENGTH,
  MIN_FACT_LENGTH,
  NON_DURABLE_FACT_KINDS,
  SELF_CONTAINED_FACT_RULE,
  UNIDENTIFIED_PERSON_RULE,
} from "./prompt";

/**
 * The pure core of **passive memory extraction**: the prompt that harvests
 * durable facts from a finished chat-day, and the parsing of what comes back. No
 * DB, no provider — so the whole decision surface is unit-testable without either.
 *
 * Why the job exists: the pending queue used to have one producer, the
 * `memory_save` tool, which only runs while the model is composing a reply — and
 * the bot only replies when addressed. So in a group the bot remembered the
 * handful of turns aimed at it and nothing from the conversation around it, which
 * is where people actually say where they live and what they do. The mirror
 * already stores every message regardless of addressing, so this reads *that*.
 *
 * It deliberately reuses the durability policy the tool uses
 * ({@link DURABLE_FACT_KINDS} et al) rather than restating it: the same sentence
 * must be worth remembering whether or not the bot happened to be spoken to.
 *
 * The pass is per chat-day and **many facts per call**, unlike the tool's one
 * fact per call: the model is reading a finished transcript rather than deciding
 * mid-reply, so it can see the whole day at once and a single pass is far cheaper
 * than one call per candidate fact.
 */

/** A fact the extraction pass proposes for the pending queue. */
export type ExtractedNote =
  | { scope: "user"; userId: string; content: string }
  | { scope: "general"; content: string };

/** A person present in the day being extracted, as the prompt shows them. */
export interface ExtractionParticipant {
  userId: string;
  label: string;
  /**
   * The other names this person is called in chat (operator-curated
   * `known_users.aliases`). Load-bearing, not decoration: a group calls people by
   * nickname, never by the `First Last (@username)` label the roster is built
   * from, so without these the model cannot tell that the person saying something
   * about themselves is a person it is allowed to store a fact about — and under
   * {@link UNIDENTIFIED_PERSON_RULE} the fact then lands in shared knowledge
   * instead of in the document of the person it is actually about.
   */
  aliases: string[];
}

export const EXTRACTION_SYSTEM = `You read one finished day of a Telegram group's chat history and extract the durable facts worth remembering long-term. You are not replying to anyone — nobody is talking to you. You are harvesting what this day revealed about the people in it.

Extract a fact when someone reveals something lastingly true about themselves — ${DURABLE_FACT_KINDS}. Extract it whether they were speaking to you, to each other, or to nobody in particular: a fact said in passing is worth exactly as much as one said to your face.

Scopes:
- "user": a fact about one specific person in the participants list, stated by that person about themselves. Set user_id to their id from that list. This is how someone is remembered across chats.
- "general": everything that cannot be filed under a person in that list — shared knowledge that is about nobody (a definition, a rule, a convention, how something works), and a fact about someone with no id here (write their name into the fact itself, so it still says who it is about). Never use "general" for a fact about someone who DOES have an id in the participants list.

Identity:
- The participants list is the only set of people you may store a fact about. Each entry may also list other names that person goes by ("also called"); those name the same person, so a fact they state about themselves while being called a nickname belongs to their id.
- ${UNIDENTIFIED_PERSON_RULE}.

Rules:
- ${FIRST_PERSON_EVIDENCE_RULE}.
- Only extract what was actually said. Never infer, guess, or fill in what someone probably meant. A fact you are not sure was stated is a fact you must not extract.
- An example is not a fact: "big companies like X" does not say anyone worked at X, and "something like Y" does not say Y. Store a claim only in the plain, unhedged form it was actually made in.
- Chat is full of memes, copypasta, and bits. Lines shaped like a script ("Name: ... Other: ...") acting out a scene, or a punchline with someone's name in it, are performance and not testimony. Never extract from them.
- Only ever use a user_id that appears in the participants list. Never invent one, and never guess an id for someone listed without one.
- Every "general" fact must name its own subject and stand alone, since it is read with no conversation around it.
- Do NOT extract: ${NON_DURABLE_FACT_KINDS}.
- Lines labelled "Bot" are your own past messages. Read them for context, but never extract a fact from something you yourself asserted — only from what the humans said. You are not a person: never store a fact about yourself, how you are configured, or how you are built, no matter who is discussing it.
- ${SELF_CONTAINED_FACT_RULE}. The reader will not have this transcript.
- Resolve relative time against the date given: write "in March 2026", never "next month".
- Write each fact in the dominant language of the conversation.
- A day of pure greetings, noise, and chit-chat legitimately yields nothing. Return an empty array — that is a correct answer, not a failure.

Respond with JSON only, in exactly this shape:
{"facts": [{"scope": "user", "user_id": "<id>", "content": "<self-contained fact>"}, {"scope": "general", "content": "<self-contained fact>"}]}`;

/**
 * Render one message as a transcript line for extraction. Unlike the summarizer's
 * line, a speaker carries their **id** — the model must attribute a `user` fact to
 * a real known-user id, and a display name is not a key: two people in a group can
 * share a first name, and the id is what the store is actually keyed by.
 *
 * `storableIds` gates that: a speaker outside it is rendered **without an id**, so
 * the model has no id to attribute a fact to and no reason to try. They still
 * appear in the transcript, because what they *say* is evidence about the people
 * who are storable.
 */
export function toExtractionLine(
  message: SummarizableMessage,
  storableIds: ReadonlySet<string>,
): string {
  const speaker =
    message.userId && storableIds.has(message.userId)
      ? `${message.label} [id:${message.userId}]`
      : message.label;
  return `[#${message.sourceMessageId}] [${message.sentAt}] ${speaker}: ${message.content}`;
}

/**
 * A speaker as the transcript alone reveals them. Distinct from
 * {@link ExtractionParticipant}: a transcript carries a label but no aliases, so
 * this is what a day's messages can tell you before `known_users` is consulted.
 */
export interface TranscriptSpeaker {
  userId: string;
  label: string;
}

/** The distinct people who actually spoke in a day, in first-seen order. */
export function participantsOf(messages: readonly SummarizableMessage[]): TranscriptSpeaker[] {
  const seen = new Map<string, TranscriptSpeaker>();
  for (const message of messages) {
    if (!message.userId || seen.has(message.userId)) continue;
    seen.set(message.userId, { userId: message.userId, label: message.label });
  }
  return [...seen.values()];
}

/**
 * One roster entry: the id a fact is filed under, the label the transcript uses,
 * and every other name the group calls them by.
 */
function rosterLine(participant: ExtractionParticipant): string {
  const also =
    participant.aliases.length > 0 ? ` — also called: ${participant.aliases.join(", ")}` : "";
  return `[id:${participant.userId}] ${participant.label}${also}`;
}

/**
 * The user half of the extraction prompt: who is here, the date, the transcript.
 *
 * `storable` is the people a `user` fact can actually be filed under — i.e. those
 * with a `known_users` row, since `memory_entries.user_id` references it. The
 * roster must not offer anyone else: a day's transcript can carry speakers who
 * were mirrored into history but never registered (imported history does exactly
 * this), and offering their ids only produces facts the store then refuses.
 *
 * A fact about anyone else is kept as named `general` knowledge (operator decision,
 * 2026-07-28) rather than dropped — see {@link UNIDENTIFIED_PERSON_RULE}. The
 * roster is still what decides *which* of the two a fact is: only someone offered
 * here can have a document of their own.
 *
 * Each entry carries the person's aliases, because the roster's job is to be
 * *recognizable*: a group says "Гоша", not "First Last (@username)", and an entry
 * the model cannot match to a speaker is an entry that stores nothing.
 */
export function buildExtractionRequest(
  date: string,
  messages: readonly SummarizableMessage[],
  storable: readonly ExtractionParticipant[],
): string {
  const storableIds = new Set(storable.map((p) => p.userId));
  const roster =
    storable.length > 0
      ? storable.map(rosterLine).join("\n")
      : "(nobody here can be filed under an id — a fact about a person today must be saved as general knowledge, naming the person in the fact itself)";
  const transcript = messages.map((m) => toExtractionLine(m, storableIds)).join("\n");
  return [
    `Date of this conversation: ${date}.`,
    "",
    "People in this conversation (use these ids for scope 'user'):",
    roster,
    "",
    "Messages:",
    transcript,
  ].join("\n");
}

/**
 * The facts the model proposed, filtered to the ones that are actually storable.
 *
 * Defensive in the same spirit as the consolidation passes: this job runs
 * unattended over every chat-day in history, so a malformed or hallucinated entry
 * must be dropped here rather than queued. In particular a `user` fact naming an
 * id that was not offered in the roster is discarded — filed under a stranger it
 * would never surface, and filed under the *wrong* person it would be worse than
 * forgotten. `knownIds` is what the caller actually showed the model, so the pass
 * cannot reach beyond the day's participants.
 */
export function parseExtractedNotes(raw: string, knownIds: readonly string[]): ExtractedNote[] {
  const parsed = extractJsonObject(raw);
  const facts = parsed?.facts;
  if (!Array.isArray(facts)) return [];

  const allowed = new Set(knownIds);
  const notes: ExtractedNote[] = [];
  const seen = new Set<string>();

  for (const entry of facts) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;

    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (content.length < MIN_FACT_LENGTH || content.length > MAX_FACT_LENGTH) continue;

    let note: ExtractedNote;
    if (obj.scope === "user") {
      const userId = typeof obj.user_id === "string" ? obj.user_id.trim() : "";
      if (!allowed.has(userId)) continue;
      note = { scope: "user", userId, content };
    } else if (obj.scope === "general") {
      note = { scope: "general", content };
    } else {
      continue;
    }

    // One pass may propose the same fact twice (a day where someone repeats
    // themselves, or two batches of a long day overlapping in subject). Queueing
    // both would spend two consolidation passes to reach the same document.
    const key = `${note.scope}|${note.scope === "user" ? note.userId : ""}|${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }

  return notes;
}
