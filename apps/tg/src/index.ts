import "dotenv/config";

import { serve } from "@hono/node-server";

import { createApi } from "./api";
import { BotManager } from "./bot-manager";
import { closeTgDb, getTgDb } from "./db";
import { startDeliveryConsumer } from "./delivery";
import { openUpdatePublisher } from "./updates";
import { optionalEnv, requireEnv } from "@assistant-hub/service";

/**
 * The tg transport's entry (redesign Phase 7): pollers for enabled
 * connections + the delivery/lifecycle consumer + the slim API. Stateless
 * but for the connection rows and owner settings it still keeps until the
 * registration slice — every conversation byte leaves as a transport-update
 * event the core's ingest persists.
 */

const redisUrl = requireEnv("REDIS_URL");
const internalToken = requireEnv("INTERNAL_API_TOKEN");
const port = Number(optionalEnv("PORT") ?? "3210");

const db = getTgDb();
const updates = openUpdatePublisher(redisUrl);
const manager = new BotManager({ db, redisUrl, updates });

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
  redisUrl,
  senderFor: (assistantId) => manager.senderFor(assistantId),
  running: () => manager.runningConnections(),
  updates,
  onAssistantDeleted: (assistantId) => manager.removeAssistant(assistantId),
});

const api = createApi({
  db,
  manager,
  internalToken,
  updates,
  running: () => manager.runningConnections(),
});
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
  await updates.close().catch(() => undefined);
  await closeTgDb().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
