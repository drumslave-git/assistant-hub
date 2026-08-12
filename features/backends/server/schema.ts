import { z } from "zod";

import { LLM_BACKEND_IDS } from "@/lib/llm-backend";

/**
 * Backends validation contract — the single source of truth for the shape and
 * bounds of the operator's endpoint catalog. Shared by the service, the Route
 * Handlers, and the Backends page.
 *
 * The API key is a secret: it is accepted on input but never returned. The
 * client-facing {@link backendSchema} exposes only `apiKeyConfigured`.
 */

const name = z.string().trim().min(1).max(100);
const baseUrl = z.string().trim().url().max(500);
const apiKey = z.string().trim().max(500);

/** Which inference server answers at the endpoint — see `@/lib/llm-backend`. */
const backendType = z.enum(LLM_BACKEND_IDS);

/** One backend as returned to clients — no secret values. */
export const backendSchema = z.object({
  id: z.string(),
  /** Display name (unique case-insensitively). */
  name,
  /** Base URL of the OpenAI-compatible endpoint. */
  baseUrl,
  /** Which inference server answers there. */
  type: backendType,
  /** Whether an API key is stored (the value itself is never exposed). */
  apiKeyConfigured: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Backend = z.infer<typeof backendSchema>;

/** Input for creating a backend. `apiKey` empty/omitted means no key. */
export const createBackendSchema = z.object({
  name,
  baseUrl,
  apiKey: apiKey.nullable().optional(),
  type: backendType,
});

export type CreateBackend = z.infer<typeof createBackendSchema>;

/**
 * Partial update input. `apiKey` is write-only: a non-empty string sets it, an
 * empty string or null clears it, and omitting it leaves the stored key
 * untouched.
 */
export const updateBackendSchema = z
  .object({
    name,
    baseUrl,
    apiKey: apiKey.nullable(),
    type: backendType,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateBackend = z.infer<typeof updateBackendSchema>;

/**
 * Input for the connection test / model preview. Either an existing backend
 * (`backendId`, testing what is stored) or an ad-hoc `baseUrl` from the create
 * form. `apiKey` follows the probe convention: omitted falls back to the stored
 * key (when a `backendId` is given), so an unchanged secret never round-trips.
 */
export const testBackendSchema = z
  .object({
    backendId: z.string().optional(),
    baseUrl: baseUrl.optional(),
    apiKey: apiKey.nullable().optional(),
  })
  .refine((v) => v.backendId !== undefined || v.baseUrl !== undefined, {
    message: "Provide a backendId or a baseUrl to test",
  });

export type TestBackend = z.infer<typeof testBackendSchema>;

/**
 * Input for the backend fingerprint probe: the URL to identify. Unauthenticated
 * native admin routes (`/api/version`, `/props`, `/version`) are what answer, so
 * no key is taken — nothing here reads or needs a secret.
 */
export const detectBackendSchema = z.object({
  baseUrl,
});

export type DetectBackend = z.infer<typeof detectBackendSchema>;
