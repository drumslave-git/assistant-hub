import "dotenv/config";

import { serve } from "@hono/node-server";

import { createApi } from "./api";
import { BotManager } from "./bot-manager";
import { closeTgDb, getTgDb } from "./db";
import { startDeliveryConsumer } from "./delivery";
import { optionalEnv, requireEnv } from "./env";

/**
 * The tg source app's entry: store + pollers for enabled connections +
 * delivery/lifecycle consumers + the Hono API. A plain long-running Node
 * service (no Next) — one of the three per-app processes of the v2
 * topology (PLAN.md).
 */

const redisUrl = requireEnv("REDIS_URL");
const internalToken = requireEnv("INTERNAL_API_TOKEN");
const port = Number(optionalEnv("PORT") ?? "3210");

const db = getTgDb();
const manager = new BotManager({ db, redisUrl });

const statuses = await manager.startEnabled();
if (statuses.length === 0) {
  console.log("No enabled telegram connections — pollers idle until one is added.");
} else {
  for (const status of statuses) {
    console.log(
      `connection ${status.connectionId} (assistant ${status.assistantId}): ${status.state}` +
        (status.username ? ` as @${status.username}` : "") +
        (status.error ? ` — ${status.error}` : ""),
    );
  }
}

const delivery = await startDeliveryConsumer({
  db,
  redisUrl,
  senderFor: (assistantId) => manager.senderFor(assistantId),
  onAssistantDeleted: (assistantId) => manager.removeAssistant(assistantId),
  crossFeed: manager.crossFeed,
});

const api = createApi({ db, manager, internalToken, crossFeed: manager.crossFeed });
const server = serve({ fetch: api.fetch, port }, (info) => {
  console.log(`tg API listening on :${info.port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — shutting down`);
  server.close();
  await delivery.close().catch(() => undefined);
  await manager.close().catch(() => undefined);
  await closeTgDb().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
