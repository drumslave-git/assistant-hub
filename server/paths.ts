import "server-only";

import path from "node:path";

/**
 * Where local runtime state lives on disk. One root, `./data`, with a fixed
 * layout — not configurable (user decision, 2026-07-29).
 *
 * | Directory | Holds |
 * | --- | --- |
 * | `data/pg` | The bundled Postgres cluster (Compose bind mount; the app never touches it) |
 * | `data/traces` | Monthly trace NDJSON logs |
 * | `data/downloads` | Files the browser agent fetched |
 *
 * These used to be three env vars (`TRACES_DIR`, `DOWNLOADS_DIR`, plus
 * `PG_DATA_DIR`/`TRACES_DATA_DIR`/`DOWNLOADS_DATA_DIR` on the Compose side), each
 * with its own default, one of which differed between local dev and the
 * container. That bought nothing: every deployment used the defaults, and the
 * divergence only made the docs longer. Relative to `process.cwd()`, which is the
 * package root locally and `/app` in the image — so the same literal resolves to
 * the paths the Dockerfile creates and Compose mounts.
 *
 * Tests must not write into the real directories; they call
 * {@link __setDataDirsForTests} rather than reaching for an env var that no
 * longer exists.
 */

/** Test-only overrides. Null in production, always. */
let overrides: { traces?: string; downloads?: string } = {};

/** Monthly trace NDJSON logs. */
export function tracesDir(): string {
  return overrides.traces ?? path.join(process.cwd(), "data", "traces");
}

/**
 * Browser-agent downloads. The only copy of a file too large to attach to the
 * chat, which is why Compose bind-mounts it to the host.
 */
export function downloadsDir(): string {
  return overrides.downloads ?? path.join(process.cwd(), "data", "downloads");
}

/**
 * Test-only: point one or both directories at throwaway paths, or pass `null` to
 * restore the real ones. Callers that cache a resolved path (the trace store
 * resolves its directory once) must reset themselves afterwards.
 */
export function __setDataDirsForTests(next: { traces?: string; downloads?: string } | null): void {
  overrides = next ?? {};
}
