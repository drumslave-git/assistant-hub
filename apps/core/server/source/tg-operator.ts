import "server-only";

import {
  DEFAULT_ASSISTANT_ID,
  operatorConnectionResponseSchema,
  operatorConnectionsResponseSchema,
  operatorSourceSettingsResponseSchema,
  type OperatorConnection,
  type OperatorSourceSettings,
} from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";
import { getEnv } from "@/server/env";

/**
 * The tg source app's operator API, reached from the core's server code (the
 * dashboard's aggregation seam — PLAN "the dashboard aggregates via the
 * shared listing/CRUD contract"). Same auth as the other internal clients:
 * the shared `INTERNAL_API_TOKEN` header; the operator session was already
 * checked by whichever dashboard surface called this.
 *
 * Phase 2 keeps the dashboard's single-bot shape: one connection, owned by
 * the default assistant. Phase 3's assistants CRUD replaces the
 * single-connection helpers below with per-assistant management.
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

/** Status probes must stay snappy — the dashboard shell awaits them. */
const REQUEST_TIMEOUT_MS = 5_000;

export interface TgOperatorClient {
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
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  const baseUrl = env.TG_API_URL.replace(/\/$/, "");
  const token = env.INTERNAL_API_TOKEN;

  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `tg operator API ${path} answered ${res.status}`);
    }
    return res.json();
  };

  return {
    async listConnections() {
      const body = operatorConnectionsResponseSchema.parse(await request("/internal/connections"));
      return body.connections;
    },
    async createConnection(input) {
      const body = operatorConnectionResponseSchema.parse(
        await request("/internal/connections", { method: "POST", body: JSON.stringify(input) }),
      );
      if (!body.connection) throw new Error("tg operator API returned no connection");
      return body.connection;
    },
    async updateConnection(id, input) {
      const body = operatorConnectionResponseSchema.parse(
        await request(`/internal/connections/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      );
      if (!body.connection) throw new Error("tg operator API returned no connection");
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

/** Map one connection (or its absence) onto the dashboard's bot status. */
function toBotStatus(connection: OperatorConnection | undefined): BotStatus {
  if (!connection) return { state: "stopped", username: null, since: null, error: null };
  if (!connection.enabled && !connection.status) {
    return { state: "stopped", username: null, since: null, error: null };
  }
  const status = connection.status;
  if (!status) {
    // Desired running but the runtime has no poller for it yet — the tg app
    // has not reconciled (or was restarted); honest state is an error the
    // operator can read, not a green light.
    return {
      state: "error",
      username: null,
      since: null,
      error: "connection is enabled but no poller is tracked — is the telegram service running?",
    };
  }
  return {
    state: status.state,
    username: status.username,
    since: status.since,
    error: status.error,
  };
}

/**
 * The dashboard's bot status + whether a token is saved, probed from the tg
 * service (real state, not env presence). An unreachable or unconfigured
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
    const connections = await client.listConnections();
    return { status: toBotStatus(connections[0]), configured: connections.length > 0 };
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

/**
 * Start/stop the (single) telegram connection: desired state written through
 * the operator API; the tg app reconciles its poller and the answer carries
 * the resulting actual state.
 */
export async function setSourceBotEnabled(enabled: boolean): Promise<BotStatus> {
  const client = tgOperatorClient();
  if (!client) {
    throw ApiError.serviceUnavailable(
      "telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN)",
    );
  }
  const [connection] = await client.listConnections();
  if (!connection) {
    throw ApiError.badRequest("No telegram connection — save a bot token in Settings first");
  }
  const updated = await client.updateConnection(connection.id, { enabled });
  return toBotStatus(updated);
}

/**
 * Save (or clear) the bot token from Settings: routed to the tg connection
 * (create for the default assistant, retoken in place, delete on clear) —
 * the token lives in the source's store since the split; the core keeps no
 * copy.
 */
export async function saveSourceBotToken(token: string | null): Promise<void> {
  const client = tgOperatorClient();
  if (!client) {
    throw ApiError.serviceUnavailable(
      "telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN) — the bot token cannot be saved",
    );
  }
  const [connection] = await client.listConnections();
  if (!token) {
    if (connection) await client.deleteConnection(connection.id);
    return;
  }
  if (connection) {
    await client.updateConnection(connection.id, { botToken: token });
    return;
  }
  // Enabled on creation: a saved token means "run this bot" (v1 autostart
  // semantics); Stop is the explicit way to keep it parked.
  await client.createConnection({ assistantId: DEFAULT_ASSISTANT_ID, botToken: token, enabled: true });
}
