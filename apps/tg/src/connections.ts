import type { ConnectionIdentity } from "@assistant-hub/contracts";

/**
 * One running connection: the assistant it serves and its bot account. Both
 * halves of shared-chat behavior ride on this list — the receivers of an
 * inbound event (each with its own structural verdict) and the `running`
 * roster a delivered event carries for the core's cross-feed.
 */
export interface AssistantConnection {
  assistantId: string;
  /** Numeric Telegram id of the bot account serving this assistant. */
  botId: number;
  identity: ConnectionIdentity;
}

/** The delivered-event roster shape (`botId` as a source-local string id). */
export function runningRoster(connections: readonly AssistantConnection[]) {
  return connections.map((connection) => ({
    assistantId: connection.assistantId,
    botId: String(connection.botId),
    identity: connection.identity,
  }));
}
