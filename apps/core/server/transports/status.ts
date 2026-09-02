import "server-only";

import type { OperatorConnection } from "@assistant-hub-swarm/contracts";

import { listConnectionViews, type TransportConnectionView } from "./service";

/**
 * The dashboard's telegram status surfaces over the transport registry —
 * what `tg-operator.ts` served over HTTP before the Phase 7 registration
 * slice: the connection roster (rows in the core store, live poller state
 * from the transport's health probe), the one-card summary, and the owner
 * write.
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

/** The operator-contract shape of one connection view (the summary's input). */
export function toOperatorConnection(view: TransportConnectionView): OperatorConnection {
  return {
    id: view.id,
    assistantId: view.assistantId,
    enabled: view.enabled,
    // The preview already reduced the secret to its last characters.
    botTokenHint: (view.configPreview.botToken ?? "????").replace(/^…/, ""),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    status: view.status,
  };
}

/** Every telegram connection (optionally one assistant's), with poller state. */
export async function listSourceConnections(
  assistantId?: string,
): Promise<OperatorConnection[]> {
  const views = await listConnectionViews("tg", assistantId);
  return views.map(toOperatorConnection);
}

/**
 * Summarize every connection into the shell's one Bot status card. Errors win
 * (an enabled connection with no tracked poller counts as one — the tg app
 * has not reconciled, or is down), then running, then stopped;
 * `configured` is simply "at least one connection exists".
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

/** The dashboard's bot status + whether any connection exists. */
export async function getSourceBotStatus(): Promise<{
  status: BotStatus;
  configured: boolean;
}> {
  try {
    return summarizeConnections(await listSourceConnections());
  } catch (err) {
    return {
      status: {
        state: "error",
        username: null,
        since: null,
        error: `telegram status unavailable: ${err instanceof Error ? err.message : String(err)}`,
      },
      configured: false,
    };
  }
}

