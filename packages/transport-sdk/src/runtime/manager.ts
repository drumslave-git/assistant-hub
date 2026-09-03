import { BUS_EVENTS_CHANNEL, type TransportDesiredState } from "@assistant-hub-swarm/contracts";
import { openPublisher, type BusPublisher } from "@assistant-hub-swarm/bus";
import { dashboardRefresh } from "@assistant-hub-swarm/service";

import type { CoreApi } from "./core-api";
import { buildEditEvent, buildInboundEvent, buildReactionEvent } from "./inbound";
import type { RunningConnection } from "./send";
import { SeenCache, type UpdatePublisher } from "./updates";
import type {
  AddressingRule,
  BotIdentity,
  ConnectionStatus,
  Normalizer,
  PlatformAdapter,
  PlatformConnection,
  PlatformHooks,
  TransportDescriptor,
} from "./types";

/**
 * Connection lifecycle, for any platform: reconcile the core's desired state
 * into live connections, supervise them, and turn everything they report
 * into contract events.
 *
 * Supervision is generic on purpose. A platform adapter says *what* went
 * wrong by reporting an error status; whether that is worth retrying, how
 * often, and what the dashboard is told is the same answer everywhere —
 * a still-desired connection is restarted on a flat interval, and each state
 * change refreshes the dashboard so a poller that dies or comes back shows
 * up without a reload.
 */

const RECONNECT_DELAY_MS = 15_000;

interface Managed {
  connectionId: string;
  assistantId: string;
  /** The config this connection was started with; reconcile compares it. */
  startedWith: string | null;
  connection: PlatformConnection | null;
  status: ConnectionStatus;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the core still wants it; a stopped-on-purpose one never retries. */
  desired: boolean;
}

export interface ConnectionManagerDeps<TRaw> {
  descriptor: TransportDescriptor;
  adapter: PlatformAdapter<TRaw>;
  normalize: Normalizer<TRaw>;
  addressing: AddressingRule<TRaw>;
  updates: UpdatePublisher;
  core: CoreApi;
  redisUrl: string;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export class ConnectionManager<TRaw> {
  private managed = new Map<string, Managed>();
  private publisher: BusPublisher;
  private seen = new SeenCache();

  constructor(private readonly deps: ConnectionManagerDeps<TRaw>) {
    this.publisher = openPublisher(deps.redisUrl);
  }

  private get source(): string {
    return this.deps.descriptor.id;
  }

  private errorText(err: unknown): string {
    return this.deps.adapter.errorText?.(err) ?? (err instanceof Error ? err.message : String(err));
  }

  /**
   * Every connection with a live bot account. A stopped or still-connecting
   * one is not: it has no identity to put on an event and could not deliver
   * an answer either.
   */
  running(): RunningConnection[] {
    return [...this.managed.values()].flatMap((entry) => {
      const identity = entry.connection?.identity();
      return identity
        ? [{ assistantId: entry.assistantId, botId: identity.id, identity: identity.identity }]
        : [];
    });
  }

  statuses(): ConnectionStatus[] {
    return [...this.managed.values()].map((entry) => ({ ...entry.status }));
  }

  /**
   * The connection to act through for one assistant. A null assistant means
   * "whichever one runs". Resolved per call, so a restart never leaves a
   * stale handle behind.
   */
  connectionFor(assistantId: string | null): PlatformConnection {
    const entry = [...this.managed.values()].find(
      (candidate) =>
        (assistantId == null || candidate.assistantId === assistantId) && candidate.connection,
    );
    if (!entry?.connection) {
      throw new Error(
        `No running ${this.source} connection${assistantId ? ` for assistant ${assistantId}` : ""}`,
      );
    }
    return entry.connection;
  }

  /**
   * Reconcile to the core's desired state (boot, and every
   * `transport.config.changed`): start what should run, restart what
   * changed, stop and drop what is gone or disabled.
   */
  async applyDesiredState(state: TransportDesiredState): Promise<ConnectionStatus[]> {
    const desired = new Map(state.connections.map((connection) => [connection.id, connection]));
    for (const connectionId of [...this.managed.keys()]) {
      const want = desired.get(connectionId);
      if (!want || !want.enabled || !state.transport.enabled) {
        await this.removeConnection(connectionId);
      }
    }
    if (!state.transport.enabled) return this.statuses();

    for (const connection of state.connections) {
      if (!connection.enabled) continue;
      const config = JSON.stringify(connection.config);
      const entry = this.managed.get(connection.id);
      // Idempotence: an unchanged running connection is left alone. Secrets
      // are not readable back off a live connection, so what it was STARTED
      // with is what the desired blob is compared against.
      if (entry?.connection && entry.startedWith === config) continue;
      await this.start(connection.id, connection.assistantId, connection.config);
    }
    return this.statuses();
  }

  /** Start (or restart) one connection. Idempotent. */
  async start(
    connectionId: string,
    assistantId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    let entry = this.managed.get(connectionId);
    if (!entry) {
      entry = {
        connectionId,
        assistantId,
        startedWith: null,
        connection: null,
        status: {
          connectionId,
          assistantId,
          state: "starting",
          username: null,
          since: null,
          error: null,
        },
        reconnectTimer: null,
        desired: false,
      };
      this.managed.set(connectionId, entry);
    }
    entry.desired = true;
    entry.startedWith = JSON.stringify(config);
    this.cancelReconnect(entry);
    if (entry.connection) await this.stop(entry);

    const managed = entry;
    let connection: PlatformConnection;
    try {
      connection = await this.deps.adapter.connect(
        { connectionId, assistantId, config },
        this.hooksFor(managed),
      );
    } catch (err) {
      this.fail(managed, err);
      return;
    }
    // Stopped while it was connecting — hand the connection straight back.
    if (!managed.desired) {
      await connection.close().catch(() => undefined);
      this.setStatus(managed, { state: "stopped", username: null, since: null, error: null });
      return;
    }
    managed.connection = connection;
    const recovered = managed.status.state === "error";
    const identity = connection.identity();
    this.setStatus(managed, {
      state: "running",
      username: identity?.identity.botUsername ?? null,
      since: new Date().toISOString(),
      error: null,
    });
    if (recovered && identity) {
      console.log(`${this.source} connection ${connectionId} reconnected`);
    }
  }

  private hooksFor(entry: Managed): PlatformHooks<TRaw> {
    const publish = (what: string, run: () => Promise<void>): void => {
      void run().catch((err) => console.error(`${this.source} ${what} failed:`, this.errorText(err)));
    };

    return {
      message: (raw) =>
        publish("inbound forwarding", async () => {
          const message = await this.deps.normalize(raw);
          if (!message) return;
          const result = buildInboundEvent({
            descriptor: this.deps.descriptor,
            raw,
            message,
            addressing: this.deps.addressing,
            receivedBy: entry.assistantId,
            running: this.identities(),
            seen: this.seen,
          });
          if (result.status === "forwarded") {
            await this.deps.updates.publish(result.event);
          } else if (result.status === "duplicate") {
            // The duplicate receipt still proves THIS bot is in the chat.
            await this.deps.updates.publish(result.presence);
          }
        }),

      edited: (input) =>
        publish("edit forwarding", async () => {
          if (!input.content.trim()) return;
          // A shared-chat edit reaches every bot in it; forward it once.
          if (
            !input.direct &&
            !this.seen.first(`e:${this.source}:${input.chatId}:${input.sourceMessageId}:${input.editedAt}`)
          ) {
            return;
          }
          await this.deps.updates.publish(
            buildEditEvent({ descriptor: this.deps.descriptor, assistantId: entry.assistantId, ...input }),
          );
        }),

      reaction: (input) =>
        publish("reaction forwarding", async () => {
          if (
            !input.direct &&
            !this.seen.first(
              `r:${this.source}:${input.chatId}:${input.sourceMessageId}:${input.user.userId}:${input.reaction}`,
            )
          ) {
            return;
          }
          await this.deps.updates.publish(
            buildReactionEvent({
              descriptor: this.deps.descriptor,
              assistantId: entry.assistantId,
              ...input,
            }),
          );
        }),

      // Synchronous by design: the platform's spinner wants an answer only
      // the flow's outcome can word, and the core owns that flow.
      menuPress: async (input) => {
        try {
          return await this.deps.core.forwardMenuPress({
            source: this.source,
            assistantId: entry.assistantId,
            chat: { id: input.chatId, kind: input.direct ? "direct" : "group" },
            user: input.user,
            menuSourceMessageId: input.menuSourceMessageId,
            data: input.data,
          });
        } catch (err) {
          console.error(`${this.source} menu press forwarding failed:`, this.errorText(err));
          return { toast: null };
        }
      },

      status: (input) => {
        if (input.state === "error") {
          this.fail(entry, input.error ?? "connection failed");
          return;
        }
        const identity = entry.connection?.identity();
        this.setStatus(entry, {
          state: "running",
          username: identity?.identity.botUsername ?? entry.status.username,
          since: entry.status.since ?? new Date().toISOString(),
          error: null,
        });
      },
    };
  }

  /** Every live bot account, for the receivers list on an inbound event. */
  private identities(): (BotIdentity & { assistantId: string })[] {
    return [...this.managed.values()].flatMap((entry) => {
      const identity = entry.connection?.identity();
      return identity ? [{ ...identity, assistantId: entry.assistantId }] : [];
    });
  }

  private setStatus(
    entry: Managed,
    status: Omit<ConnectionStatus, "connectionId" | "assistantId">,
  ): void {
    entry.status = { connectionId: entry.connectionId, assistantId: entry.assistantId, ...status };
    this.deps.onStatusChange?.({ ...entry.status });
    // The dashboard's connection card watches `status`.
    void this.publisher
      .publish(BUS_EVENTS_CHANNEL, dashboardRefresh(this.source, ["status"]))
      .catch(() => undefined);
  }

  /** Record a failure and, while the core still wants it, keep retrying. */
  private fail(entry: Managed, err: unknown): void {
    const message = this.errorText(err);
    if (entry.status.state !== "error") {
      console.error(
        `${this.source} connection ${entry.connectionId} is down: ${message}` +
          (entry.desired ? ` — retrying every ${RECONNECT_DELAY_MS / 1000}s` : ""),
      );
    }
    entry.connection = null;
    this.setStatus(entry, {
      state: "error",
      username: null,
      since: null,
      error: entry.desired ? `${message} — reconnecting automatically` : message,
    });
    this.cancelReconnect(entry);
    if (!entry.desired) return;
    const config = entry.startedWith;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.start(
        entry.connectionId,
        entry.assistantId,
        config ? (JSON.parse(config) as Record<string, unknown>) : {},
      ).catch((retryErr: unknown) => this.fail(entry, retryErr));
    }, RECONNECT_DELAY_MS);
    entry.reconnectTimer.unref?.();
  }

  private cancelReconnect(entry: Managed): void {
    if (!entry.reconnectTimer) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  /** Stop a removed connection and drop it from the status listing. */
  async removeConnection(connectionId: string): Promise<void> {
    const entry = this.managed.get(connectionId);
    if (!entry) return;
    entry.desired = false;
    await this.stop(entry);
    this.managed.delete(connectionId);
  }

  private async stop(entry: Managed): Promise<void> {
    this.cancelReconnect(entry);
    const connection = entry.connection;
    entry.connection = null;
    if (connection) {
      await connection
        .close()
        .catch((err: unknown) =>
          console.error(`Failed to stop ${this.source} connection:`, this.errorText(err)),
        );
    }
    this.setStatus(entry, { state: "stopped", username: null, since: null, error: null });
  }

  /** Stop everything. Shutdown entry. */
  async close(): Promise<void> {
    for (const entry of this.managed.values()) {
      entry.desired = false;
      await this.stop(entry);
    }
    await this.publisher.close();
  }
}
