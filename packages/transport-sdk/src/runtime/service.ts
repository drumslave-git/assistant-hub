import { BUS_EVENTS_CHANNEL } from "@assistant-hub-swarm/contracts";
import { openSubscriber, type BusSubscription } from "@assistant-hub-swarm/bus";
import { optionalEnv, requireEnv } from "@assistant-hub-swarm/service";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createCoreApi, type CoreApi } from "./core-api";
import { startDeliveryConsumer, type DeliveryConsumer } from "./delivery";
import { createTransportApi } from "./http";
import { ConnectionManager } from "./manager";
import { registerDeliveryTools, type DeliveryToolTexts } from "./mcp";
import type { SendContext } from "./send";
import { openUpdatePublisher, type UpdatePublisher } from "./updates";
import type {
  AddressingRule,
  ConnectionStatus,
  Normalizer,
  PlatformAdapter,
  TransportDescriptor,
} from "./types";

/**
 * One call boots a whole transport.
 *
 * Everything below is the same for every platform and none of it is worth
 * writing twice: read the environment, serve `/health` from the first
 * moment, register with the core (retrying — the core may boot second),
 * reconcile the connections it asks for, refetch on every config change,
 * consume the deliveries it publishes, host the delivery tools, and shut all
 * of that down in the right order on a signal.
 *
 * What a transport supplies is its platform: the {@link PlatformAdapter},
 * the {@link Normalizer}, the {@link AddressingRule} and the
 * {@link TransportDescriptor}. Anything else it needs — extra MCP tools, an
 * extra route — is passed in below and composed on top; the runtime never
 * has to learn about a platform to make room for it.
 *
 * Environment read here, and only here:
 * `REDIS_URL`, `INTERNAL_API_TOKEN`, `CORE_API_URL` (default
 * `http://localhost:3200`), `SELF_URL` (default `http://localhost:$PORT`),
 * `PORT`.
 */

export interface TransportServiceOptions<TRaw> {
  descriptor: TransportDescriptor;
  adapter: PlatformAdapter<TRaw>;
  normalize: Normalizer<TRaw>;
  addressing: AddressingRule<TRaw>;
  /** The default port when `PORT` is unset. */
  defaultPort?: number;
  /**
   * How the delivery tools word themselves, and any tools of the platform's
   * own to register alongside them. A transport with no extra tools passes
   * only `platform`.
   */
  tools?: DeliveryToolTexts & {
    register?: (server: McpServer, context: TransportRuntime<TRaw>) => void;
  };
  /** Serve nothing at `/mcp` (a transport that hosts no tools at all). */
  hostsTools?: boolean;
}

/** What the runtime hands back — everything a transport might still need. */
export interface TransportRuntime<TRaw> {
  descriptor: TransportDescriptor;
  manager: ConnectionManager<TRaw>;
  core: CoreApi;
  updates: UpdatePublisher;
  send: SendContext;
  statuses: () => ConnectionStatus[];
  /** Stop everything, in order. Called for you on SIGINT/SIGTERM. */
  shutdown: () => Promise<void>;
}

export async function startTransportService<TRaw>(
  options: TransportServiceOptions<TRaw>,
): Promise<TransportRuntime<TRaw>> {
  const { descriptor } = options;
  const redisUrl = requireEnv("REDIS_URL");
  const internalToken = requireEnv("INTERNAL_API_TOKEN");
  const port = Number(optionalEnv("PORT") ?? String(options.defaultPort ?? 3210));

  const updates = openUpdatePublisher(redisUrl);
  const core = createCoreApi({
    descriptor,
    baseUrl: optionalEnv("CORE_API_URL") ?? "http://localhost:3200",
    token: internalToken,
    selfUrl: optionalEnv("SELF_URL") ?? `http://localhost:${port}`,
  });
  const manager = new ConnectionManager<TRaw>({
    descriptor,
    adapter: options.adapter,
    normalize: options.normalize,
    addressing: options.addressing,
    updates,
    core,
    redisUrl,
  });

  const errorText = (err: unknown): string =>
    options.adapter.errorText?.(err) ?? (err instanceof Error ? err.message : String(err));

  const send: SendContext = {
    descriptor,
    publisher: updates,
    running: () => manager.running(),
    connectionFor: (assistantId) => manager.connectionFor(assistantId),
  };

  const runtime: TransportRuntime<TRaw> = {
    descriptor,
    manager,
    core,
    updates,
    send,
    statuses: () => manager.statuses(),
    shutdown: () => shutdown("shutdown()"),
  };

  const hostsTools = options.hostsTools ?? true;
  const api = createTransportApi({
    send,
    internalToken,
    statuses: () => manager.statuses(),
    errorText,
    mcpServer: hostsTools
      ? () => {
          // Built per session, like every MCP server over HTTP.
          const server = new McpServer({ name: `${descriptor.id}-transport`, version: "1.0.0" });
          registerDeliveryTools(server, {
            descriptor,
            send,
            errorText,
            texts: options.tools ?? { platform: descriptor.name },
          });
          options.tools?.register?.(server, runtime);
          return server;
        }
      : null,
  });

  // `/health` answers from the first moment; connections join once the core
  // has answered the registration.
  const server = serve({ fetch: api.fetch, port }, (info) => {
    console.log(`${descriptor.id} API listening on :${info.port}`);
  });

  const desired = await core.registerUntilAccepted();
  console.log(
    `registered with the core — ${desired.connections.length} connection(s) desired` +
      (desired.transport.enabled ? "" : " (transport disabled)"),
  );
  for (const status of await manager.applyDesiredState(desired)) {
    console.log(
      `connection ${status.connectionId} (assistant ${status.assistantId}): ${status.state}` +
        (status.username ? ` as ${status.username}` : "") +
        (status.error ? ` — ${status.error}` : ""),
    );
  }
  if (manager.statuses().length === 0) {
    console.log(`No enabled ${descriptor.name} connections — idle until one is added.`);
  }

  /** Refetch + reconcile, serialized — bursts of changes collapse harmlessly. */
  let reconciling: Promise<void> = Promise.resolve();
  const scheduleReconcile = (reason: string): void => {
    reconciling = reconciling.then(async () => {
      try {
        await manager.applyDesiredState(await core.desiredState());
        console.log(`desired state reconciled (${reason})`);
      } catch (err) {
        console.error(`desired-state reconcile failed (${reason}):`, errorText(err));
      }
    });
  };

  const configWatch: BusSubscription = await openSubscriber(
    redisUrl,
    BUS_EVENTS_CHANNEL,
    (payload) => {
      const type =
        payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
      // `assistant.deleted` has no per-connection event: its cascade removes
      // connections, so the desired state is the only thing that knows.
      if (
        (type === "transport.config.changed" &&
          (payload as { transport?: string }).transport === descriptor.id) ||
        type === "assistant.deleted"
      ) {
        scheduleReconcile(String(type));
      }
    },
    (error) => console.error("bus payload parse failed:", error),
  );

  const delivery: DeliveryConsumer = await startDeliveryConsumer({
    redisUrl,
    descriptor,
    send,
    isDirect: (chatId) => manager.connectionFor(null).isDirectChat(chatId),
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
  }

  process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

  return runtime;
}
