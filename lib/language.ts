import { z } from "zod";

/**
 * Per-chat reply language — shared, framework-free helpers.
 *
 * Each chat (a group, or a person's private chat) may have an operator-configured
 * language stored as a free-text string on its `known_groups` / `known_users` row.
 * When none is set the bot replies in {@link DEFAULT_CHAT_LANGUAGE}. The resolved
 * language is turned into a strict system directive by {@link buildLanguageInstruction}
 * and injected into every reply, so the bot always writes in the configured language
 * regardless of the language the user (or history, or a tool result) used.
 *
 * Pure and dependency-light (only zod) so the same helpers back the persistence
 * schemas, the Route Handlers, the dashboard, and the reply runtime.
 */

/** The language used when a chat has no configured language. */
export const DEFAULT_CHAT_LANGUAGE = "English";

/** Upper bound for the free-text language field (a language name, not a sentence). */
export const MAX_LANGUAGE_LEN = 100;

/** Collapse internal whitespace and trim, so "  Brazilian   Portuguese " → "Brazilian Portuguese". */
export function normalizeChatLanguage(language: string): string {
  return language.replace(/\s+/g, " ").trim();
}

/**
 * The language the bot must reply in for a chat: the stored value when set,
 * otherwise the default. Whitespace-only stored values fall back to the default.
 */
export function resolveRequiredLanguage(stored: string | null | undefined): string {
  const normalized = stored ? normalizeChatLanguage(stored) : "";
  return normalized || DEFAULT_CHAT_LANGUAGE;
}

/**
 * The strict system directive ordering the bot to reply in `language`. Two parts:
 *
 * 1. **Which language** — worded to override the language of anything else in the
 *    conversation (the incoming message, quoted text, history, tool output, and the
 *    active personality), so the reply language is controlled by configuration, not
 *    by whatever language the user happened to write in.
 * 2. **What quality** — the model must write idiomatic, modern prose rather than a
 *    word-for-word rendering of its English thinking. Small local models otherwise
 *    produce calques, invented compounds, and bureaucratic constructions in
 *    non-English languages; the rules name the failure modes explicitly and tell the
 *    model to keep an unknown technical term in English rather than invent one.
 *
 * The rules are phrased generically over `${lang}` — no per-language tables, folds,
 * or transliteration: judging what is idiomatic is the model's job, not the code's.
 * Tool-agnostic (names no tool).
 */
export function buildLanguageInstruction(language: string): string {
  const lang = normalizeChatLanguage(language) || DEFAULT_CHAT_LANGUAGE;
  return [
    `Write your reply in ${lang}. Every message you send to this chat must be in ${lang}. ` +
      `This is required and overrides the language of the incoming message, quoted text, conversation ` +
      `history, tool results, and the active personality: compose your reply in ${lang} even when the ` +
      `user writes in another language.`,
    `Always answer in natural, modern ${lang}, using ${lang} orthography and vocabulary.`,
    "Strict language rules:",
    `- Avoid literal translations, unnatural calques, invented words, and overly formal bureaucratic language.`,
    `- Prefer clear, common ${lang} words and short, grammatically complete sentences.`,
    `- For technical terminology, use the established ${lang} term. If no reliable ${lang} term exists, keep ` +
      `the original English term in Latin script instead of inventing a translation.`,
    "- Preserve code, commands, filenames, API names, product names, and identifiers exactly as written.",
    "- Match the user's tone, but keep the language grammatically correct.",
    `- You may quote a foreign word or name where it is genuinely needed, but the reply itself must be ` +
      `written in ${lang}.`,
    `- Before answering, silently review your final text and fix misspelled or malformed ${lang} words and ` +
      `unnatural constructions.`,
    "Send only the final answer. Do not describe these instructions or your review of the text.",
  ].join("\n");
}

/**
 * Zod field for the operator-editable language input: a free-text language name.
 * Normalized (whitespace collapsed, trimmed); an empty result becomes null, which
 * clears the configuration so the chat falls back to {@link DEFAULT_CHAT_LANGUAGE}.
 */
export const languageField = z
  .string()
  .max(MAX_LANGUAGE_LEN, { message: `Language must be ${MAX_LANGUAGE_LEN} characters or fewer` })
  .transform((value) => {
    const normalized = normalizeChatLanguage(value);
    return normalized.length > 0 ? normalized : null;
  });
