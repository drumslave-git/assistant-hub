import "server-only";

import {
  operatorConnectionResponseSchema,
  operatorConnectionsResponseSchema,
  operatorSourceSettingsResponseSchema,
  type OperatorConnection,
  type OperatorSourceSettings,
} from "@assistant-hub/contracts";

import { ApiError, isApiError } from "@/lib/api-error";

import {
  createDirectoryClient,
  operatorRequester,
  type SourceDirectoryClient,
} from "./operator-client";

/**
 * The tg source app's operator API, reached from the core's server code (the
 * dashboard's aggregation seam — PLAN "the dashboard aggregates via the
 * shared listing/CRUD contract"). Same auth as the other internal clients:
 * the shared `INTERNAL_API_TOKEN` header; the operator session was already
 * checked by whichever dashboard surface called this.
 *
 * Connections are per assistant since Phase 3: the assistant editor's tg
 * section manages them through the proxy routes below, and the dashboard's
 * status surfaces summarize across all of them.
 */

/** Dashboard-facing poller status — the v1 `BotStatus` shape, kept. */
export interface BotStatus {
  state: "stopped" | "running" | "error";
  username: string | null;
  /** ISO time the current run started, or null when not running. */
  since: string | null;
  /** Last error message when `state` is `error`, else null. */
  error: string | null;
}

export interface TgOperatorClient extends SourceDirectoryClient {
  listConnections(): Promise<OperatorConnection[]>;
  createConnection(input: {
    assistantId: string;
    botToken: string;
    enabled: boolean;
  }): Promise<OperatorConnection>;
  updateConnection(
    id: string,
    input: { botToken?: string; enabled?: boolean },
  ): Promise<OperatorConnection>;
  deleteConnection(id: string): Promise<void>;
  getSettings(): Promise<OperatorSourceSettings>;
  putSettings(input: {
    ownerUsername: string | null;
    ownerUserId?: string | null;
  }): Promise<OperatorSourceSettings>;
}

/** The client, or null when the source API is not configured. */
export function tgOperatorClient(): TgOperatorClient | null {
  const resolved = operatorRequester("tg");
  if (!resolved) return null;
  const { request, label } = resolved;

  return {
    ...createDirectoryClient(request, label),
    async listConnections() {
      const body = operatorConnectionsResponseSchema.parse(await request("/internal/connections"));
      return body.connections;
    },
    async createConnection(input) {
      const body = operatorConnectionResponseSchema.parse(
        await request("/internal/connections", { method: "POST", body: JSON.stringify(input) }),
      );
      if (!body.connection) throw new Error(`${label} returned no connection`);
      return body.connection;
    },
    async updateConnection(id, input) {
      const body = operatorConnectionResponseSchema.parse(
        await request(`/internal/connections/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
      if (!body.connection) throw new Error(`${label} returned no connection`);
      return body.connection;
    },
    async deleteConnection(id) {
      await request(`/internal/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async getSettings() {
      const body = operatorSourceSettingsResponseSchema.parse(await request("/internal/settings"));
      return body.settings;
    },
    async putSettings(input) {
      const body = operatorSourceSettingsResponseSchema.parse(
        await request("/internal/settings", { method: "PUT", body: JSON.stringify(input) }),
      );
      return body.settings;
    },
  };
}

/**
 * The owner write: the source resolves `isOwner` per inbound event, so the
 * identity must land there or the change never takes effect.
 */
export async function saveSourceOwner(input: {
  ownerUsername: string | null;
  ownerUserId: string | null;
}): Promise<void> {
  const client = tgOperatorClient();
  if (!client) {
    throw ApiError.serviceUnavailable(
      "telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN) — the owner cannot be saved",
    );
  }
  await client.putSettings(input);
}

/**
 * Summarize every connection into the shell's one Bot status card. Errors win
 * (an enabled connection with no tracked poller counts as one — the tg app
 * has not reconciled, or was restarted), then running, then stopped;
 * `configured` is simply "at least one connection exists". With several
 * connections the error message is prefixed with the failing bot's identity.
 * Pure, exported for its unit tests.
 */
export function summarizeConnections(connections: OperatorConnection[]): {
  status: BotStatus;
  configured: boolean;
} {
  const failed = connections.find(
    (c) => c.status?.state === "error" || (c.enabled && !c.status),
  );
  if (failed) {
    const message =
      failed.status?.error ??
      "connection is enabled but no poller is tracked — is the telegram service running?";
    const label = failed.status?.username
      ? `@${failed.status.username}`
      : `token …${failed.botTokenHint}`;
    return {
      status: {
        state: "error",
        username: failed.status?.username ?? null,
        since: null,
        error: connections.length > 1 ? `${label}: ${message}` : message,
      },
      configured: true,
    };
  }
  const running = connections.filter((c) => c.status?.state === "running");
  if (running.length > 0) {
    // With several bots up there is no single identity to show — consumers
    // render a null username as a plural.
    return {
      status: {
        state: "running",
        username: running.length === 1 ? (running[0].status?.username ?? null) : null,
        since: running.length === 1 ? (running[0].status?.since ?? null) : null,
        error: null,
      },
      configured: true,
    };
  }
  return {
    status: { state: "stopped", username: null, since: null, error: null },
    configured: connections.length > 0,
  };
}

/** Non-ApiError failures (a refused fetch, a timeout) become a legible 503. */
function toUnreachable(err: unknown): ApiError {
  if (isApiError(err)) return err;
  return ApiError.serviceUnavailable(
    `telegram service unreachable: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function requireClient(action: string): TgOperatorClient {
  const client = tgOperatorClient();
  if (!client) {
    throw ApiError.serviceUnavailable(
      `telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN) — ${action}`,
    );
  }
  return client;
}

/** Every connection (optionally one assistant's), joined with poller state. */
export async function listSourceConnections(
  assistantId?: string,
): Promise<OperatorConnection[]> {
  const client = requireClient("connections cannot be read");
  try {
    const connections = await client.listConnections();
    return assistantId
      ? connections.filter((c) => c.assistantId === assistantId)
      : connections;
  } catch (err) {
    throw toUnreachable(err);
  }
}

/**
 * Connect a bot to an assistant. Enabled on creation: a saved token means
 * "run this bot" (v1 autostart semantics); Stop is the explicit way to keep
 * it parked. One bot per assistant — the source answers a 409 otherwise,
 * relayed as a conflict.
 */
export async function createSourceConnection(input: {
  assistantId: string;
  botToken: string;
}): Promise<OperatorConnection> {
  const client = requireClient("the connection cannot be created");
  try {
    return await client.createConnection({ ...input, enabled: true });
  } catch (err) {
    throw toUnreachable(err);
  }
}

/** Desired-state change (retoken, start/stop); the tg app reconciles its poller. */
export async function updateSourceConnection(
  id: string,
  input: { botToken?: string; enabled?: boolean },
): Promise<OperatorConnection> {
  const client = requireClient("the connection cannot be updated");
  try {
    return await client.updateConnection(id, input);
  } catch (err) {
    throw toUnreachable(err);
  }
}

/** Remove a connection: the row, its stored token, and its poller. */
export async function deleteSourceConnection(id: string): Promise<void> {
  const client = requireClient("the connection cannot be removed");
  try {
    await client.deleteConnection(id);
  } catch (err) {
    throw toUnreachable(err);
  }
}

/**
 * The dashboard's bot status + whether any connection exists, probed from the
 * tg service (real state, not env presence). An unreachable or unconfigured
 * service reads as an error state — after the source split a dashboard
 * without its telegram service is a misconfiguration worth surfacing, never
 * a silent "stopped".
 */
export async function getSourceBotStatus(): Promise<{
  status: BotStatus;
  configured: boolean;
}> {
  const client = tgOperatorClient();
  if (!client) {
    return {
      status: {
        state: "error",
        username: null,
        since: null,
        error: "telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN)",
      },
      configured: false,
    };
  }
  try {
    return summarizeConnections(await client.listConnections());
  } catch (err) {
    return {
      status: {
        state: "error",
        username: null,
        since: null,
        error: `telegram service unreachable: ${err instanceof Error ? err.message : String(err)}`,
      },
      configured: false,
    };
  }
}
