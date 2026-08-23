import "server-only";

import { readFileSync } from "node:fs";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";

/**
 * Server-only environment access.
 *
 * Single source of truth for process configuration. Values are resolved once,
 * lazily, with support for Docker secret `<NAME>_FILE` variants (matching the
 * MVP contract). Required-for-a-capability checks are explicit via
 * {@link requireEnv} rather than failing the whole process at boot, so the
 * dashboard can run and report what is missing.
 */

/**
 * Resolve a raw env value, honoring the `<NAME>_FILE` Docker-secret convention:
 * if `NAME` is unset but `NAME_FILE` points to a readable file, its trimmed
 * contents are used.
 */
function resolveRaw(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct !== "") return direct;

  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    try {
      const contents = readFileSync(fileVar, "utf8").trim();
      if (contents) return contents;
    } catch {
      // Fall through to undefined; requireEnv reports the missing capability.
    }
  }
  return undefined;
}

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .transform((v) => (v === "" ? undefined : v));

/**
 * Known environment variables. Env is bootstrap-only: runtime configuration
 * (LLM connection, bot token, prompts, feature settings) lives in DB-backed
 * Settings edited via the dashboard. All keys are optional at parse time;
 * requirements are enforced where the capability is used.
 */
const envSchema = z.object({
  // Persistence
  DATABASE_URL: optionalString,
  /**
   * The v2 core store (redesign transition) — a separate database with its
   * own migration chain (`store/`). Collapses to DATABASE_URL at cutover.
   */
  STORE_DATABASE_URL: optionalString,

  // Redis (bus + inbound queue). Unset → the queue consumer stays off.
  REDIS_URL: optionalString,

  // The tg source app's internal API (redesign transition): base URL and the
  // shared secret both sides present. Media describe/transcribe on the
  // queue-consumer path needs them.
  TG_API_URL: optionalString,
  INTERNAL_API_TOKEN: optionalString,

  // Runtime
  TZ: optionalString,
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Env keys that support `<NAME>_FILE` Docker-secret resolution. */
const KNOWN_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

let cached: Env | null = null;

/** Parsed, validated environment. Resolved once and cached. */
export function getEnv(): Env {
  if (cached) return cached;

  const resolved: Record<string, string | undefined> = {};
  for (const key of KNOWN_KEYS) resolved[key] = resolveRaw(key);

  const parsed = envSchema.safeParse(resolved);
  if (!parsed.success) {
    throw ApiError.internal("Invalid environment configuration", {
      details: z.flattenError(parsed.error).fieldErrors,
      cause: parsed.error,
    });
  }
  cached = parsed.data;
  return cached;
}

/**
 * Read an env var that is required for the current operation. Throws a
 * `service_unavailable` {@link ApiError} with a clear message when it is unset,
 * so callers surface a clean 503 rather than a raw crash.
 */
export function requireEnv(key: keyof Env): string {
  const value = getEnv()[key];
  if (typeof value !== "string" || value.length === 0) {
    throw ApiError.serviceUnavailable(
      `Missing required configuration: ${key}. Set ${key} (or ${key}_FILE) in the environment.`,
    );
  }
  return value;
}

/** Test-only: reset the cache so a new env can be parsed. */
export function resetEnvCache(): void {
  cached = null;
}
