import type { FeedbackReaction, FeedbackTopic } from "./types";

/**
 * Predefined feedback menu options (user decision, 2026-07-14). Five per
 * reaction plus a free-text "Other". Code constants — the stored feedback is the
 * option's text, so renaming an option later does not corrupt stored rows.
 *
 * Options are only ever *appended*: the menu's `callback_data` carries the
 * option's index, so reordering the list would make an in-flight menu resolve to
 * a different answer than the one its button showed.
 */

/** What the user liked (👍 menu). */
export const LIKE_OPTIONS = [
  "Helpful & accurate",
  "Right tone/personality",
  "Good length & format",
  "Funny/entertaining",
  "Understood the context",
] as const;

/**
 * The complaint that the bot should not have replied at all: it read someone
 * else's name as its own and joined a conversation it was not part of. Unlike
 * every other option this one is not about the reply's *content*, and answering
 * it does more than record a row — the word that mis-triggered the addressing
 * analyzer is filed as an exclusion so the same name stops summoning the bot
 * (see `features/bot-messaging/exclusions.ts`).
 */
export const NOT_ADDRESSED_OPTION = "Wasn't talking to you";

/** What the user disliked (👎 menu). */
export const DISLIKE_OPTIONS = [
  "Inaccurate or wrong",
  "Wrong tone",
  "Too long or rambling",
  "Missed the point/context",
  "Generic or boring",
  NOT_ADDRESSED_OPTION,
] as const;

/** Label of the free-text option button. */
export const OTHER_OPTION_LABEL = "Other — write your own";

/** The predefined option list for a reaction. */
export function optionsForReaction(reaction: FeedbackReaction): readonly string[] {
  return reaction === "up" ? LIKE_OPTIONS : DISLIKE_OPTIONS;
}

/** The topic an answer belongs to, derived from the answer itself. */
export function topicForAnswer(answer: string): FeedbackTopic {
  return answer.trim() === NOT_ADDRESSED_OPTION ? "addressing" : "quality";
}
