/**
 * Addressing exclusions — words the analyzer must stop reading as the bot's
 * display name. Client-safe half: the row shape the dashboard renders and the
 * one normalization rule the whole feature agrees on.
 */

/** One excluded word (client-safe). */
export interface AddressingExclusion {
  id: string;
  /** The word verbatim, as it appeared in the message that mis-triggered. */
  term: string;
  /** Case-folded, whitespace-collapsed form — what the mechanical check matches. */
  normalized: string;
  /** The bot display name the false match was made against. */
  botDisplayName: string;
  /** Where the report came from (provenance — the exclusion applies bot-wide). */
  chatId: string | null;
  telegramMessageId: number | null;
  userId: string | null;
  feedbackId: string | null;
  createdAt: string;
}

/**
 * The comparable form of a word: trimmed, inner whitespace collapsed, case
 * folded. Deliberately *only* mechanical — no transliteration, no romanization,
 * no phonetic folding. Recognizing an excluded word in a declined or
 * transliterated form is the model's job (the prompt lists the terms); code
 * decides nothing linguistic.
 */
export function normalizeExclusionTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether a word is on the exclusion list (exact, case-folded). */
export function isExcludedTerm(term: string, exclusions: readonly string[]): boolean {
  const normalized = normalizeExclusionTerm(term);
  if (!normalized) return false;
  return exclusions.some((excluded) => normalizeExclusionTerm(excluded) === normalized);
}
