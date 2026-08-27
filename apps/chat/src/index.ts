import "dotenv/config";

import { serve } from "@hono/node-server";
import { optionalEnv, requireEnv } from "@assistant-hub/service";

import { createApi } from "./api";
import { closeChatDb, getChatDb } from "./db";

/**
 * The chat source app's entry: store + the Hono API. A plain long-running
 * Node service (no Next — user decision, 2026-08-27: its dashboard UI renders
 * inside the core's build as `apps/chat/ui`), one of the three per-app
 * processes of the v2 topology (PLAN.md).
 *
 * Slice A boots the store and the operator API. The inbound producer and the
 * delivery/lifecycle consumers — the halves that need Redis — join in slice B,
 * which is why `REDIS_URL` is not required here yet.
 */

const internalToken = requireEnv("INTERNAL_API_TOKEN");
const port = Number(optionalEnv("PORT") ?? "3220");

const db = getChatDb();

const api = createApi({ db, internalToken });
const server = serve({ fetch: api.fetch, port }, (info) => {
  console.log(`chat API listening on :${info.port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — shutting down`);
  server.close();
  await closeChatDb().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
