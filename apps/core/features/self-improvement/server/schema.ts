import { z } from "zod";

/**
 * Validation schemas for the self-improvement feature. Like history, this
 * feature is driven by the Telegram runtime rather than client forms, so these
 * validate the runtime's inputs before they reach persistence.
 */

export const feedbackReactionSchema = z.enum(["up", "down"]);

/** A 👍/👎 reaction on a bot reply (from a `message_reaction` update). */
export const reactionInputSchema = z.object({
  chatId: z.string().min(1),
  /** Telegram message id of the reacted message. */
  telegramMessageId: z.number().int().positive(),
  /** Who reacted. */
  userId: z.string().min(1),
  reaction: feedbackReactionSchema,
});
export type ReactionInput = z.infer<typeof reactionInputSchema>;

/** A free-text answer captured from a reply to the menu message. */
export const captureReplyInputSchema = z.object({
  chatId: z.string().min(1),
  /** The menu message the user replied to. */
  menuMessageId: z.number().int().positive(),
  userId: z.string().min(1),
  text: z.string().trim().min(1).max(4096),
});
export type CaptureReplyInput = z.infer<typeof captureReplyInputSchema>;
