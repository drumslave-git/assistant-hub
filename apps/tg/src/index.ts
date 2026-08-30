import "dotenv/config";

import { serve } from "@hono/node-server";
import { openSubscriber, type BusSubscription } from "@assistant-hub/bus";
import { BUS_EVENTS_CHANNEL } from "@assistant-hub/contracts";
import { optionalEnv, requireEnv } from "@assistant-hub/service";

import { createApi } from "./api";
import { BotManager } from "./bot-manager";
import { startDeliveryConsumer } from "./delivery";
import { fetchDesiredState, registerUntilAccepted } from "./desired-state";
import { OwnerConfig } from "./owner";
import { openUpdatePublisher } from "./updates";

/**
 * The tg transport's entry (redesign Phase 7): a fully stateless service.
 * It registers with the core at boot, reconciles its pollers from the
 * desired state the core answers with, forwards everything it sees as
 * transport-update events, and refetches on every `transport.config.changed`
 * (and on `assistant.deleted`, whose cascade removes connections without a
 * per-row event). No database, no files — the core remembers.
 */

const redisUrl = requireEnv("REDIS_URL");
const internalToken = requireEnv("INTERNAL_API_TOKEN");
const port = Number(optionalEnv("PORT") ?? "3210");

const updates = openUpdatePublisher(redisUrl);
const owner = new OwnerConfig();
const manager = new BotManager({ redisUrl, updates, owner });

// The API serves /health from the first moment; pollers join once the core
// has answered the registration.
const api = createApi({
  manager,
  internalToken,
  updates,
  running: () => manager.runningConnections(),
});
const server = serve({ fetch: api.fetch, port }, (info) => {
  console.log(`tg API listening on :${info.port}`);
});

const desired = await registerUntilAccepted(port);
console.log(
  `registered with the core — ${desired.connections.length} connection(s) desired` +
    (desired.transport.enabled ? "" : " (transport disabled)"),
);
const statuses = await manager.applyDesiredState(desired);
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

/** Refetch + reconcile, serialized — bursts of changes collapse harmlessly. */
let reconciling: Promise<void> = Promise.resolve();
function scheduleReconcile(reason: string): void {
  reconciling = reconciling.then(async () => {
    try {
      await manager.applyDesiredState(await fetchDesiredState());
      console.log(`desired state reconciled (${reason})`);
    } catch (err) {
      console.error(
        `desired-state reconcile failed (${reason}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

const configWatch: BusSubscription = await openSubscriber(
  redisUrl,
  BUS_EVENTS_CHANNEL,
  (payload) => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
    if (
      (type === "transport.config.changed" &&
        (payload as { transport?: string }).transport === "tg") ||
      type === "assistant.deleted"
    ) {
      scheduleReconcile(String(type));
    }
  },
  (error) => console.error("bus payload parse failed:", error),
);

const delivery = await startDeliveryConsumer({
  redisUrl,
  senderFor: (assistantId) => manager.senderFor(assistantId),
  running: () => manager.runningConnections(),
  updates,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — shutting down`);
  server.close();
  await configWatch.close().catch(() => undefined);
  await delivery.close().catch(() => undefined);
  await manager.close().catch(() => undefined);
  await updates.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
