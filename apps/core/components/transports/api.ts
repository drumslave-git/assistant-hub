import type { TransportConfigField } from "@assistant-hub-swarm/contracts";
import { apiFetch } from "@assistant-hub-swarm/ui";

/**
 * The dashboard's one client for the transport routes
 * (`/api/transports/**`): the registered transports and each transport's
 * per-assistant connections. Both surfaces that drive a connection — the
 * assistant editor's schema-driven section and the Overview's start/stop
 * rows — call through here, so the route shapes live in exactly one place
 * (the Overview once kept its own copy pointed at routes that no longer
 * existed).
 *
 * Shapes mirror what `server/transports/service.ts` serves; secrets arrive
 * only as the masked preview the server produced.
 */

/** One registered transport, as `GET /api/transports` lists it. */
export interface TransportSummary {
  id: string;
  name: string;
  enabled: boolean;
  /** Whether the transport has announced itself (an empty URL = never). */
  registered: boolean;
  /** The contract major it announced. */
  contractMajor: number;
  /** False when this core speaks another contract major; `refusedReason` says so. */
  compatible: boolean;
  refusedReason: string | null;
  connectionConfigSchema: TransportConfigField[];
  transportConfigSchema: TransportConfigField[];
  configPreview: Record<string, string>;
}

/** Live poller state the transport reports for one connection. */
export interface ConnectionStatus {
  state: "running" | "error" | "stopped";
  username: string | null;
  since: string | null;
  error: string | null;
}

/** One connection as the dashboard renders it (config as masked preview). */
export interface ConnectionView {
  id: string;
  assistantId: string;
  enabled: boolean;
  /** Per schema field: the stored value, secrets reduced to a hint. */
  configPreview: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  status: ConnectionStatus | null;
}

/** What a connection edit may change: a config merge, the run switch, or both. */
export interface ConnectionPatch {
  config?: Record<string, string>;
  enabled?: boolean;
}

const connectionsPath = (transportId: string): string =>
  `/api/transports/${encodeURIComponent(transportId)}/connections`;

const connectionPath = (transportId: string, connectionId: string): string =>
  `${connectionsPath(transportId)}/${encodeURIComponent(connectionId)}`;

/** The registered transports (the editor renders one section per row). */
export async function fetchTransports(): Promise<TransportSummary[]> {
  const data = await apiFetch<{ transports: TransportSummary[] }>("/api/transports");
  return data?.transports ?? [];
}

/** One transport's connections, optionally one assistant's, with live state. */
export async function fetchConnections(
  transportId: string,
  assistantId?: string,
): Promise<ConnectionView[]> {
  const query = assistantId ? `?assistantId=${encodeURIComponent(assistantId)}` : "";
  const data = await apiFetch<{ connections: ConnectionView[] }>(
    `${connectionsPath(transportId)}${query}`,
  );
  return data?.connections ?? [];
}

/** Connect an assistant to a transport with the config its schema asked for. */
export async function createConnection(
  transportId: string,
  input: { assistantId: string; config: Record<string, string> },
): Promise<ConnectionView | null> {
  const data = await apiFetch<{ connection: ConnectionView | null }>(connectionsPath(transportId), {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data?.connection ?? null;
}

/**
 * Re-config (shallow merge) and/or start/stop. The route answers with the
 * row's id and run switch only — the live state arrives on the next
 * `status` event once the transport has reconciled.
 */
export async function patchConnection(
  transportId: string,
  connectionId: string,
  patch: ConnectionPatch,
): Promise<{ id: string; enabled: boolean }> {
  const data = await apiFetch<{ connection: { id: string; enabled: boolean } }>(
    connectionPath(transportId, connectionId),
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.connection;
}

/** Remove a connection and its stored config; the transport stops running it. */
export async function deleteConnection(transportId: string, connectionId: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(connectionPath(transportId, connectionId), {
    method: "DELETE",
  });
}
