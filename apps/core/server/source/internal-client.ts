import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";

import { ApiError } from "@/lib/api-error";
import { getEnv } from "@/server/env";
import { getTransport } from "@/server/transports/service";

/**
 * How the core talks to a transport's `/internal/*` surface — one requester
 * for every transport and every call (menu operations, the outbound sends).
 *
 * Which app answers is a REGISTRATION lookup since Phase 7 (PLAN.md "The
 * transport contract"): the base URL comes from the transport's
 * self-registration row, never from an env var — adding a transport to a
 * running core is deploying one container, not configuring the core. The
 * web chat has no entry: it is a core feature, and its per-source ports
 * resolve to in-process implementations.
 */

export interface InternalApiConfig {
  baseUrl: string;
  token: string;
}

/**
 * The transport's internal API config, or null when it has never registered
 * (or the shared token is unset). Null is a normal state — callers report
 * the transport as unavailable rather than failing the whole read.
 */
export async function sourceApiConfig(source: SourceId): Promise<InternalApiConfig | null> {
  if (source === "chat") return null;
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token) return null;
  const row = await getTransport(source).catch(() => null);
  if (!row || !row.baseUrl) return null;
  return { baseUrl: row.baseUrl.replace(/\/$/, ""), token };
}

export type InternalRequest = (
  path: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<unknown>;

export interface InternalRequesterOptions {
  /** Resolve the transport's config per call — registration can change. */
  config: () => Promise<InternalApiConfig | null>;
  /** Named in error messages, e.g. `tg internal API`. */
  label: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Build the requester for one transport API. Failures keep the transport's
 * own verdict where it has one — a 409 must reach the dashboard as a
 * conflict, not a generic 500 — and anything unclassified becomes
 * `service_unavailable`, which is what an unreachable app is.
 */
export function internalRequester(options: InternalRequesterOptions): InternalRequest {
  const { label } = options;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (path, init) => {
    const config = await options.config();
    if (!config) {
      throw ApiError.serviceUnavailable(`${label} is not registered with this core`);
    }
    const res = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": config.token,
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
