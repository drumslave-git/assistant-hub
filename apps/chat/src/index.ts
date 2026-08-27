import "dotenv/config";

import { serve } from "@hono/node-server";
import { openPublisher, openQueue } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import { dashboardRefresh, optionalEnv, requireEnv } from "@assistant-hub/service";

import { createApi } from "./api";
import { closeChatDb, getChatDb } from "./db";
import { startDeliveryConsumer } from "./delivery";

/**
 * The chat source app's entry: store + the inbound queue producer + the
 * delivery/lifecycle consumer + the Hono API. A plain long-running Node
 * service (no Next — user decision, 2026-08-27: its dashboard UI renders
 * inside the core's build as `apps/chat/ui`), one of the three per-app
 * processes of the v2 topology (PLAN.md).
 */

const redisUrl = requireEnv("REDIS_URL");
const internalToken = requireEnv("INTERNAL_API_TOKEN");
const port = Number(optionalEnv("PORT") ?? "3220");

const db = getChatDb();

const queue = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl);
const publisher = openPublisher(redisUrl);
const delivery = await startDeliveryConsumer({ db, redisUrl });

const api = createApi({
  db,
  internalToken,
  enqueue: async (event) => {
    await queue.add("message.inbound", event);
  },
  // Every thread change the operator makes is also something a dashboard page
  // is showing — ping the topic rather than make anyone reload.
  onThreadsChanged: () => {
    void publisher
      .publish(BUS_EVENTS_CHANNEL, dashboardRefresh("chat", ["threads"]))
      .catch(() => undefined);
  },
});
const server = serve({ fetch: api.fetch, port }, (info) => {
  console.log(`chat API listening on :${info.port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — shutting down`);
  server.close();
  await delivery.close().catch(() => undefined);
  await publisher.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  await closeChatDb().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
