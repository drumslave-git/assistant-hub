/**
 * Client-safe types for the self-improvement feature: user feedback collected
 * via 👍/👎 reactions, and the versioned artifacts the daily job distills from
 * it (per-user communication preferences + global self-corrections).
 */

/** Which thumb the user reacted with. */
export type FeedbackReaction = "up" | "down";

/**
 * Feedback lifecycle: menu sent (`pending`) → user tapped "Other" and we await
 * their reply to the menu message (`awaiting_text`) → answer stored
 * (`completed`).
 */
export type FeedbackStatus = "pending" | "awaiting_text" | "completed";

/**
 * What a feedback answer is about: the reply itself (`quality` — every option
 * but one, and all free text) or the fact that the bot answered someone who was
 * not talking to it (`addressing`). An `addressing` answer is a routing report,
 * so the daily folds skip it (user decision, 2026-07-26) — "you should not have
 * replied" folded into a per-user preference or the global system prompt would
 * teach style from a mis-fire. Its actual fix is an addressing exclusion.
 */
export type FeedbackTopic = "quality" | "addressing";

/** One collected feedback row (client-safe). */
export interface UserFeedback {
  id: string;
  chatId: string;
  /** Telegram message id of the reacted bot reply. */
  telegramMessageId: number;
  userId: string;
  reaction: FeedbackReaction;
  /** The chosen option text or the user's own words; null until answered. */
  feedback: string | null;
  status: FeedbackStatus;
  /** What the answer is about — see {@link FeedbackTopic}. */
  topic: FeedbackTopic;
  /** Clean model name that generated the reacted reply (informational). */
  model: string;
  /**
   * The bot's own account of what went right or wrong in the reacted reply and
   * why, written from the reply's trace plus this feedback. Null until it is
   * written (and while the answer is still missing — there is nothing to explain
   * yet). Both incorporation folds read it alongside the raw feedback.
   */
  reflection: string | null;
  /** Clean model name that wrote {@link reflection}, or null. */
  reflectionModel: string | null;
  /** Preferences version that incorporated this feedback, or null. */
  prefsVersion: number | null;
  /** Self-corrections version that incorporated this feedback, or null. */
  correctionsVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One versioned per-user preferences snapshot (client-safe). */
export interface CommunicationPreference {
  id: string;
  userId: string;
  model: string;
  likes: string;
  dislikes: string;
  version: number;
  createdAt: string;
}

/** One versioned global self-correction snapshot (client-safe). */
export interface SelfCorrection {
  id: string;
  model: string;
  correction: string;
  version: number;
  createdAt: string;
}
