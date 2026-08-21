import { z } from "zod";

import { MAX_FACT_LENGTH, MIN_FACT_LENGTH } from "../prompt";

/**
 * Memory validation contract — the single source of truth for the shape of the
 * operator's edits. Shared by the service, the Route Handlers, and the dashboard.
 *
 * The `memory_save` tool validates against the same bounds through its own MCP
 * input schema (the model's inputs are not HTTP inputs), but the length rules
 * live once, in `../prompt`.
 */

const content = z
  .string()
  .trim()
  .min(MIN_FACT_LENGTH, "Memory cannot be empty")
  .max(MAX_FACT_LENGTH, `Memory must be at most ${MAX_FACT_LENGTH} characters`);

/** Rewrite one person's memory document. */
export const updateUserMemorySchema = z.object({ content });
export type UpdateUserMemory = z.infer<typeof updateUserMemorySchema>;

/**
 * Rewrite the general-knowledge document. There is no "create" counterpart: the
 * document is a singleton, so writing it is an upsert — the first edit creates it.
 */
export const updateGeneralMemorySchema = z.object({ content });
export type UpdateGeneralMemory = z.infer<typeof updateGeneralMemorySchema>;
