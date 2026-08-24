import { z } from "zod";

/**
 * Assistants validation contract — the single source of truth for the shape
 * of an assistant and for create/update inputs. Shared by the service, Route
 * Handlers, and the dashboard. Assistants are the first-class successor of
 * personalities (PLAN "Assistants"): many per deployment, each with its own
 * persona and (per source app) transport connection; there is no "active"
 * selection — the assistant in a chat is implied by which bot is in it.
 */

/** Bounds (carried over from the personalities limits). */
export const MAX_ASSISTANTS = 32;
export const MAX_NAME_LEN = 64;
export const MAX_PERSONA_LEN = 32_000;

const name = z.string().trim().min(1, "Name is required").max(MAX_NAME_LEN);
const persona = z.string().trim().max(MAX_PERSONA_LEN);

/** An assistant as returned to clients (no secrets). */
export const assistantSchema = z.object({
  id: z.string(),
  name: z.string(),
  persona: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Assistant = z.infer<typeof assistantSchema>;

/** Create input: a required name and an optional persona (defaults to empty). */
export const createAssistantSchema = z.object({
  name,
  persona: persona.optional().default(""),
});

export type CreateAssistant = z.infer<typeof createAssistantSchema>;

/** Update input: any subset of the editable fields; at least one is required. */
export const updateAssistantSchema = z
  .object({ name, persona })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateAssistant = z.infer<typeof updateAssistantSchema>;
