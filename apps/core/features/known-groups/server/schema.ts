import { z } from "zod";

import { languageField } from "@/lib/language";

/**
 * Known-groups validation contract — the single source of truth for the shape of
 * a known group, its members, and operator note/language edits. Shared by the
 * service, Route Handlers, and the dashboard. Mirrors the known-users contract.
 */

/** A known group as returned to clients. */
export const knownGroupSchema = z.object({
  chatId: z.string(),
  title: z.string().nullable(),
  type: z.string().nullable(),
  notes: z.string().nullable(),
  language: z.string().nullable(),
  firstSeenAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type KnownGroup = z.infer<typeof knownGroupSchema>;

/** A known group plus its member count (list view). */
export interface KnownGroupSummary extends KnownGroup {
  memberCount: number;
}

/** A group member as returned to clients (known-user profile + membership times). */
export interface GroupMember {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** A group with its resolved member list (detail view). */
export interface GroupWithMembers {
  group: KnownGroup;
  members: GroupMember[];
}

/** Upper bound for the operator-curated notes field. */
const MAX_NOTES_LEN = 2000;

/**
 * Notes-edit input: a free-text description. Trimmed; an empty result clears the
 * notes (stored as null) so blank input removes the description cleanly.
 */
export const updateGroupNotesSchema = z.object({
  notes: z
    .string()
    .max(MAX_NOTES_LEN, { message: `Notes must be ${MAX_NOTES_LEN} characters or fewer` })
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }),
});

export type UpdateGroupNotes = z.infer<typeof updateGroupNotesSchema>;

/**
 * Language-edit input for a group: a free-text language name. Normalized; an
 * empty result clears the configuration (stored null → default language).
 */
export const updateGroupLanguageSchema = z.object({ language: languageField });

export type UpdateGroupLanguage = z.infer<typeof updateGroupLanguageSchema>;
