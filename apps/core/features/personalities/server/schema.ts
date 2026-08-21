import { z } from "zod";

/**
 * Personalities validation contract — the single source of truth for the shape
 * of a personality and for create/update/active-selection inputs. Shared by the
 * service, Route Handlers, and the dashboard.
 */

/** Bounds (mirrors the MVP's personality limits). */
export const MAX_PERSONALITIES = 32;
export const MAX_NAME_LEN = 64;
export const MAX_PROMPT_LEN = 32_000;

const name = z.string().trim().min(1, "Name is required").max(MAX_NAME_LEN);
const prompt = z.string().trim().max(MAX_PROMPT_LEN);

/** A personality as returned to clients (no secrets). */
export const personalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Personality = z.infer<typeof personalitySchema>;

/** Create input: a required name and an optional prompt (defaults to empty). */
export const createPersonalitySchema = z.object({
  name,
  prompt: prompt.optional().default(""),
});

export type CreatePersonality = z.infer<typeof createPersonalitySchema>;

/** Update input: any subset of the editable fields; at least one is required. */
export const updatePersonalitySchema = z
  .object({ name, prompt })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdatePersonality = z.infer<typeof updatePersonalitySchema>;

/** Set-active input: a personality id, or null to clear the active selection. */
export const setActivePersonalitySchema = z.object({
  personalityId: z.string().min(1).nullable(),
});

export type SetActivePersonality = z.infer<typeof setActivePersonalitySchema>;
