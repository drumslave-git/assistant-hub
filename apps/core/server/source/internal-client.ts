import "server-only";

import type { SourceId } from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";
import { getEnv, type Env } from "@/server/env";

/**
 * How the core talks to a source app's `/internal/*` surface — one requester
 * for every source and every call (the operator listing, the media API, the
 * outbound sends).
 *
 * Which app answers is a lookup, not a branch: a source's base URL is an env
 * key derived from its id, so adding a source means adding an env var, never
 * an `if (source === …)` (PLAN.md, "The transport contract").
 *
 * Only sources served by a separate app appear here. `chat` is deliberately
 * absent since the dissolve (Phase 6): the web chat is a core feature, its
 * per-source ports resolve to in-process implementations, and asking for its
 * "API config" correctly answers null.
 */

const API_URL_ENV: Partial<Record<SourceId, keyof Env>> = {
  tg: "TG_API_URL",
};

export interface InternalApiConfig {
  baseUrl: string;
  token: string;
}

/**
 * The source's internal API config, or null when this deployment does not run
 * that app. Null is a normal state — callers report the source as
 * unavailable rather than failing the whole read.
 */
export function sourceApiConfig(source: SourceId): InternalApiConfig | null {
  const envKey = API_URL_ENV[source];
  if (!envKey) return null;
  const env = getEnv();
  const baseUrl = env[envKey];
  if (!baseUrl || !env.INTERNAL_API_TOKEN) return null;
  return { baseUrl: String(baseUrl).replace(/\/$/, ""), token: env.INTERNAL_API_TOKEN };
}

export type InternalRequest = (
  path: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<unknown>;

export interface InternalRequesterOptions extends InternalApiConfig {
  /** Named in error messages, e.g. `tg operator API`. */
  label: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Build the requester for one source API. Failures keep the source's own
 * verdict where it has one — a 409 "already has a connection" must reach the
 * dashboard as a conflict, not as a generic 500 — and anything unclassified
 * becomes `service_unavailable`, which is what an unreachable app is.
 */
export function internalRequester(options: InternalRequesterOptions): InternalRequest {
  const { baseUrl, token, label } = options;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (path, init) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(init?.timeoutMs ?? defaultTimeout),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message = body?.error?.message ?? `${label} ${path} answered ${res.status}`;
      if (res.status === 400) throw ApiError.badRequest(message);
      if (res.status === 404) throw ApiError.notFound(message);
      if (res.status === 409) throw ApiError.conflict(message);
      throw ApiError.serviceUnavailable(message);
    }
    return res.json();
  };
}
