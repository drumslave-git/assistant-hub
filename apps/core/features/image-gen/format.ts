import type { ImageSize } from "@/server/llm/images";

/**
 * Pure text shaping for the image-generation tool result — what the *model* reads
 * back after a generation. The bytes never reach it (they are delivered to the
 * chat out-of-band), so this text is the model's only evidence of what happened,
 * and it has to be unambiguous in both directions: on success, that the image is
 * already in the chat and must not be described; on failure, that nothing was
 * sent and it must not pretend otherwise.
 *
 * Client-safe apart from the `ImageSize` type import (types are erased).
 */

/** Longest prompt echoed back in a failure message. */
const MAX_ECHOED_PROMPT = 60;

/**
 * The text handed to the model after a successful generation. It states the image
 * is already delivered, and explicitly forbids describing its contents: the model
 * never saw the image, so anything it says about what is *in* it is invention.
 */
export function formatImageSuccess(count: number, size: ImageSize): string {
  const noun = count === 1 ? "image" : "images";
  const pronoun = count === 1 ? "it" : "them";
  return (
    `Generated ${count} ${noun} (${size[0]}x${size[1]}) and delivered ${pronoun} to the chat. ` +
    `You have NOT seen ${pronoun} — do not describe or claim anything about the contents. ` +
    `Just briefly acknowledge the ${noun} in your reply.`
  );
}

/**
 * The text handed to the model when generation failed. Leads with the reason
 * rather than the prompt: the prompt can be long and the reason is the actionable
 * part, so a reader (or a truncating view) sees why first.
 */
export function formatImageFailure(prompt: string, reason: string): string {
  const trimmed = prompt.trim();
  const echoed =
    trimmed.length > MAX_ECHOED_PROMPT ? `${trimmed.slice(0, MAX_ECHOED_PROMPT)}…` : trimmed;
  return (
    `Image generation failed: ${reason}. ` +
    (echoed ? `(prompt: "${echoed}") ` : "") +
    "No image was sent. Tell the user you could not generate the image — " +
    "do not claim you made one."
  );
}
