import { z } from "zod";

import { languageField } from "@/lib/language";

/**
 * Known-users validation contract — the single source of truth for the shape of
 * a known user and for alias/language edits. Shared by the service, Route
 * Handlers, and the dashboard.
 */

/** A known user as returned to clients. */
export const knownUserSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  aliases: z.array(z.string()),
  language: z.string().nullable(),
  firstSeenAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type KnownUser = z.infer<typeof knownUserSchema>;

/** Bounds for the operator-curated alias list. */
const MAX_ALIASES = 20;
const MAX_ALIAS_LEN = 60;

/**
 * Alias-edit input: a list of non-empty, trimmed nicknames. Blanks are dropped
 * and duplicates (case-insensitive) collapsed so the stored list is clean.
 */
export const updateAliasesSchema = z.object({
  aliases: z
    .array(z.string())
    // Clean first: trim, drop blanks, collapse case-insensitive duplicates.
    .transform((list) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of list) {
        const a = raw.trim();
        if (!a) continue;
        const key = a.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
      }
      return out;
    })
    // Then bound the cleaned result.
    .refine((list) => list.length <= MAX_ALIASES, { message: `At most ${MAX_ALIASES} aliases` })
    .refine((list) => list.every((a) => a.length <= MAX_ALIAS_LEN), {
      message: `Each alias must be ${MAX_ALIAS_LEN} characters or fewer`,
    }),
});

export type UpdateAliases = z.infer<typeof updateAliasesSchema>;

/**
 * Language-edit input for a user's DM: a free-text language name. Normalized;
 * an empty result clears the configuration (stored null → default language).
 */
export const updateUserLanguageSchema = z.object({ language: languageField });

export type UpdateUserLanguage = z.infer<typeof updateUserLanguageSchema>;
