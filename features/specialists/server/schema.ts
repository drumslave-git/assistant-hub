import { z } from "zod";

/**
 * Specialists validation contract — the single source of truth for the shape of
 * a specialist, its per-chat activation, and the unified entry store's inputs.
 * Shared by the service, Route Handlers, the MCP toolkit, and the dashboard.
 */

/** Bounds (the personalities limits, plus entry-store guardrails). */
export const MAX_SPECIALISTS = 32;
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1_000;
export const MAX_INSTRUCTIONS_LEN = 32_000;
/** Free-text collection label the model picks. */
export const MAX_COLLECTION_LEN = 128;
/** Payload-size cap per entry (serialized JSON bytes) — a guardrail, not a schema. */
export const MAX_ENTRY_PAYLOAD_BYTES = 16_384;
/** Result cap per toolkit query (no retention/expiry in v1 — only read caps). */
export const MAX_QUERY_RESULTS = 50;

/** `per-chat`: each chat is its own silo. `shared`: one pool across active chats. */
export const DATA_SCOPES = ["per-chat", "shared"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

const name = z.string().trim().min(1, "Name is required").max(MAX_NAME_LEN);
const description = z.string().trim().max(MAX_DESCRIPTION_LEN);
const instructions = z.string().trim().max(MAX_INSTRUCTIONS_LEN);
const dataScope = z.enum(DATA_SCOPES);

/** A specialist as returned to clients (no secrets involved). */
export const specialistSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  dataScope,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Specialist = z.infer<typeof specialistSchema>;

/** Create input: a required name; the rest defaults to empty/per-chat. */
export const createSpecialistSchema = z.object({
  name,
  description: description.optional().default(""),
  instructions: instructions.optional().default(""),
  dataScope: dataScope.optional().default("per-chat"),
});

export type CreateSpecialist = z.infer<typeof createSpecialistSchema>;

/** Update input: any subset of the editable fields; at least one is required. */
export const updateSpecialistSchema = z
  .object({ name, description, instructions, dataScope })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateSpecialist = z.infer<typeof updateSpecialistSchema>;

/** Dashboard assignment input: a chat and a specialist id, or null to clear. */
export const setChatSpecialistSchema = z.object({
  chatId: z.string().trim().min(1, "chatId is required"),
  specialistId: z.string().min(1).nullable(),
});

export type SetChatSpecialist = z.infer<typeof setChatSpecialistSchema>;

/** One chat's active specialist, as shown on the assignment view. */
export const chatSpecialistSchema = z.object({
  chatId: z.string(),
  specialistId: z.string(),
  activatedByUserId: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

export type ChatSpecialist = z.infer<typeof chatSpecialistSchema>;

/** A stored entry as returned to clients and the dashboard browser. */
export const specialistEntrySchema = z.object({
  id: z.string(),
  specialistId: z.string(),
  chatId: z.string(),
  authorUserId: z.string().nullable(),
  collection: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SpecialistEntry = z.infer<typeof specialistEntrySchema>;

/** Entries-browser query (dashboard): all filters optional. */
export const listEntriesQuerySchema = z.object({
  specialistId: z.string().optional(),
  chatId: z.string().optional(),
  collection: z.string().optional(),
});

export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
