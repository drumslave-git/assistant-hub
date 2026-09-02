import "server-only";

import {
  incompatibilityReason,
  listConnectionViews,
  listTransports,
  transportCompatible,
  type TransportConnectionView,
} from "./service";

/**
 * The dashboard's bot status over the transport registry: every registered
 * transport's connection roster (rows in the core store, live poller state
 * from the transport's health probe) and the one-card summary the shell and
 * the Overview render. Nothing here knows which platforms are registered —
 * the roster is whatever announced itself.
 */

/** Dashboard-facing bot status — the v1 `BotStatus` shape, kept. */
export interface BotStatus {
  state: "stopped" | "running" | "error";
  username: string | null;
  /** ISO time the current run started, or null when not running. */
  since: string | null;
  /** Last error message when `state` is `error`, else null. */
  error: string | null;
}

/** One registered transport with its connections, as the Overview lists them. */
export interface TransportRoster {
  id: string;
  /** The name the transport announced ("Telegram"). */
  name: string;
  /** Why this core refused the transport, or null when it is compatible. */
  refusedReason: string | null;
  connections: TransportConnectionView[];
  /** Why the connection listing failed, or null (the transport's rows are then empty). */
  error: string | null;
}

/** Every registered transport's roster, in registration order. */
export async function listTransportRosters(): Promise<TransportRoster[]> {
  const rows = await listTransports();
  return Promise.all(
    rows.map(async (row) => {
      const refusedReason = transportCompatible(row)
        ? null
        : incompatibilityReason(row.id, row.contractMajor);
      const base = { id: row.id, name: row.name, refusedReason };
      if (refusedReason) return { ...base, connections: [], error: null };
      try {
        return { ...base, connections: await listConnectionViews(row.id), error: null };
      } catch (err) {
        return {
          ...base,
          connections: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** How a connection is named in an error: its bot's handle, else its transport and masked config. */
function connectionLabel(roster: TransportRoster, connection: TransportConnectionView): string {
  if (connection.status?.username) return `@${connection.status.username}`;
  const preview = Object.entries(connection.configPreview)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
  return preview ? `${roster.name} ${preview}` : roster.name;
}

/**
 * Summarize every transport's connections into the shell's one Bot status
 * card. Errors win — a refused transport, a transport whose listing failed,
 * a connection in error, or an enabled connection with no tracked poller (the
 * transport has not reconciled, or is down) — then running, then stopped;
 * `configured` is simply "at least one connection exists".
 */
export function summarizeTransports(rosters: readonly TransportRoster[]): {
  status: BotStatus;
  configured: boolean;
} {
  const connections = rosters.flatMap((roster) => roster.connections);
  const configured = connections.length > 0;
  const error = (message: string, username: string | null = null) => ({
    status: { state: "error" as const, username, since: null, error: message },
    configured,
  });

  const refused = rosters.find((roster) => roster.refusedReason);
  if (refused) return error(refused.refusedReason!);
  const unlisted = rosters.find((roster) => roster.error);
  if (unlisted) return error(`${unlisted.name}: ${unlisted.error}`);

  for (const roster of rosters) {
    const failed = roster.connections.find(
      (c) => c.status?.state === "error" || (c.enabled && !c.status),
    );
    if (!failed) continue;
    const message =
      failed.status?.error ??
      `connection is enabled but no poller is tracked — is the ${roster.name} transport running?`;
    const label = connectionLabel(roster, failed);
    return error(
      connections.length > 1 ? `${label}: ${message}` : message,
      failed.status?.username ?? null,
    );
  }

  const running = connections.filter((c) => c.status?.state === "running");
  if (running.length > 0) {
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
    configured,
  };
}

/** The dashboard's bot status + whether any connection exists. */
export async function getTransportsStatus(): Promise<{
  status: BotStatus;
  configured: boolean;
}> {
  try {
    return summarizeTransports(await listTransportRosters());
  } catch (err) {
    return {
      status: {
        state: "error",
        username: null,
        since: null,
        error: `transport status unavailable: ${err instanceof Error ? err.message : String(err)}`,
      },
      configured: false,
    };
  }
}
