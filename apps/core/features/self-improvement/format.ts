/**
 * Prompt-context formatting for the self-improvement feature. Pure/client-safe
 * (mirrors `features/known-users/format.ts`): the server service resolves the
 * data, these functions shape the text injected into the reply prompt.
 */

/** Inputs for the per-user preferences context block. */
export interface PreferencesContextParts {
  /** Human label of the sender (known-user label shape). */
  label: string;
  likes: string;
  dislikes: string;
}

/**
 * The per-user communication-preferences block injected as a system message on
 * a reply (parallel of the known-user identity block). Returns null when there
 * is nothing useful to inject.
 */
export function formatPreferencesContext(parts: PreferencesContextParts): string | null {
  const likes = parts.likes.trim();
  const dislikes = parts.dislikes.trim();
  if (!likes && !dislikes) return null;
  const lines = [
    `Communication preferences of ${parts.label}, learned from their feedback on your earlier replies:`,
  ];
  if (likes) lines.push(`- They like: ${likes}`);
  if (dislikes) lines.push(`- They dislike: ${dislikes}`);
  lines.push("Adapt the style and content of your reply to this person accordingly.");
  return lines.join("\n");
}
