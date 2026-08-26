import { z } from "zod";

import { scopedRefSchema } from "@assistant-hub/contracts";

/**
 * Person-links validation contract — the single source of truth for the shape
 * of a person link and for its create/update inputs. Shared by the service,
 * Route Handlers, and the dashboard.
 *
 * A link is the operator's declaration that several identities are the same
 * human (PLAN.md, "Person links"): "tg user X = web user Y", or two accounts
 * on one source. Memory reads resolve through it, so what the bot knows about
 * a person follows them across the identities they reach it by; unlinked
 * identities stay separate.
 */

/** Upper bound for the operator's free-text note about who this person is. */
export const MAX_NOTE_LEN = 500;

/** A link needs at least two identities to say anything. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 20;

const note = z
  .string()
  .max(MAX_NOTE_LEN, { message: `Note must be ${MAX_NOTE_LEN} characters or fewer` })
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

/**
 * The member list: scoped user refs, deduplicated, at least two of them. An
 * identity belongs to at most one link (the store enforces it), so a ref
 * already claimed elsewhere is a conflict the service reports, not something
 * this schema can see.
 */
const members = z
  .array(scopedRefSchema)
  .transform((list) => [...new Set(list)])
  .refine((list) => list.length >= MIN_MEMBERS, {
    message: `A link needs at least ${MIN_MEMBERS} identities`,
  })
  .refine((list) => list.length <= MAX_MEMBERS, {
    message: `At most ${MAX_MEMBERS} identities per link`,
  });

/** One identity in a link, resolved against the aggregated directory. */
export const personLinkMemberSchema = z.object({
  /** Scoped user ref (`tg:user:123`) — the stored identity. */
  userRef: z.string(),
  /** Source the ref belongs to, and its human name. */
  source: z.string(),
  sourceLabel: z.string(),
  /**
   * Display label from that source's directory, or null when no source
   * currently knows the ref (a person the source has forgotten, or a source
   * that could not be read — shown as the bare ref rather than invented).
   */
  label: z.string().nullable(),
  addedAt: z.string().datetime(),
});

export type PersonLinkMember = z.infer<typeof personLinkMemberSchema>;

/** A person link as returned to clients. */
export const personLinkSchema = z.object({
  id: z.string(),
  note: z.string().nullable(),
  members: z.array(personLinkMemberSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PersonLink = z.infer<typeof personLinkSchema>;

/** Create input: the identities to join, plus an optional note. */
export const createPersonLinkSchema = z.object({
  members,
  note: note.optional().default(""),
});

export type CreatePersonLink = z.infer<typeof createPersonLinkSchema>;

/**
 * Update input: the note, or the member list — one field per call (the
 * dashboard saves each on its own; same convention as the directory edits).
 * There is no "remove the last identity": a link with one member says
 * nothing, so breaking a person apart is a delete.
 */
export const updatePersonLinkSchema = z.union([
  z.object({ note }),
  z.object({ members }),
]);

export type UpdatePersonLink = z.infer<typeof updatePersonLinkSchema>;
