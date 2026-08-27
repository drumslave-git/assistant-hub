import type { MiddlewareHandler } from "hono";

/**
 * The guard on a source app's `/internal/*` surface: only the core reaches
 * it, and it proves that with the shared `INTERNAL_API_TOKEN` header (user
 * decision, 2026-08-23 — a shared secret rather than network topology, since
 * dev runs everything on localhost). The operator session was already checked
 * by whichever dashboard surface called through the core's proxy.
 */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

export function internalTokenGuard(expected: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header(INTERNAL_TOKEN_HEADER) !== expected) {
      return c.json({ error: { message: "unauthorized" } }, 401);
    }
    await next();
  };
}
