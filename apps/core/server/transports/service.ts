import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import {
  type SourceId,
  type TransportConfigChangedEvent,
  type TransportDesiredState,
  type TransportRegistrationRequest,
} from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishBusEvent } from "@/server/bus/publisher";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import { silencedAssistantIds } from "@/server/ownership";

import {
  assistantTransports,
  transports,
  type AssistantTransportRow,
  type TransportRow,
} from "../../store/schema";

/**
 * Transport registrations and per-assistant connections (redesign Phase 7,
 * PLAN.md "The transport contract"): a transport self-registers at boot with
 * its id, name, base URL, MCP path and config schemas; the row is what every
 * core→transport call resolves against, and the opaque config blobs — the
 * transport-level one (telegram's owner identity) and the per-assistant
 * connection sections (bot tokens) — are the transport's to interpret, never
 * the core's. Desired-state changes are announced on the bus
 * (`transport.config.changed`); the transport refetches and reconciles.
 */

const FEATURE = FEATURES["tool-connections"];

/** Registration: upsert the announced identity, keep the admin's decisions. */
export async function registerTransport(
  request: TransportRegistrationRequest,
  db: StoreDb = getStoreDb(),
): Promise<TransportDesiredState> {
  await db
    .insert(transports)
    .values({
      id: request.id,
      name: request.name,
      baseUrl: request.baseUrl,
      mcpPath: request.mcpPath,
      connectionConfigSchema: request.connectionConfigSchema,
      transportConfigSchema: request.transportConfigSchema,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: transports.id,
      // The announced identity follows the code; `enabled` and `config` are
      // the admin's and survive every re-registration.
      set: {
        name: request.name,
        baseUrl: request.baseUrl,
        mcpPath: request.mcpPath,
        connectionConfigSchema: request.connectionConfigSchema,
        transportConfigSchema: request.transportConfigSchema,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
  publishEvent("status");
  return desiredTransportState(request.id, db);
}

/** The desired state one transport reconciles from. */
export async function desiredTransportState(
  id: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<TransportDesiredState> {
  const row = await getTransport(id, db);
  if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
  const connections = await db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.transport, id))
    .orderBy(asc(assistantTransports.createdAt));
  // Offboarding (Phase 9): a deactivated account's assistants run nothing.
  // Computed, not stored, so reactivation restores the exact prior state.
  const silenced = await silencedAssistantIds(db);
  return {
    transport: { enabled: row.enabled, config: row.config },
    connections: connections.map((connection) => ({
      id: connection.id,
      assistantId: connection.assistantId,
      config: connection.config,
      // A disabled transport runs nothing, whatever its connections say.
      enabled: row.enabled && connection.enabled && !silenced.has(connection.assistantId),
    })),
  };
}

export async function getTransport(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow | null> {
  const rows = await db.select().from(transports).where(eq(transports.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Every registered transport, oldest first (the dashboard's roster). */
export async function listTransports(db: StoreDb = getStoreDb()): Promise<TransportRow[]> {
  return db.select().from(transports).orderBy(asc(transports.registeredAt));
}

/** Announce a desired-state change; the transport refetches and reconciles. */
export async function announceTransportChange(transport: SourceId): Promise<void> {
  const event: TransportConfigChangedEvent = {
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: `transport:${transport}`,
    type: "transport.config.changed",
    transport,
  };
  const published = await publishBusEvent(event).catch(() => false);
  if (!published) {
    console.error(
      `transport.config.changed for '${transport}' was NOT published (bus unconfigured?) — ` +
        "the transport will not pick the change up until restart",
    );
  }
  publishEvent("status");
}

/**
 * Merge a transport-side config writeback (telegram persisting the resolved
 * owner id) into the transport-level blob. Shallow merge — the transport
 * owns the keys.
 */
export async function mergeTransportConfig(
  id: SourceId,
  patch: Record<string, unknown>,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  const row = await getTransport(id, db);
  if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
  const updated = await db
    .update(transports)
    .set({ config: { ...row.config, ...patch }, updatedAt: new Date() })
    .where(eq(transports.id, id))
    .returning();
  publishEvent("status");
  return updated[0];
}

/** The operator's transport-level settings write (traced; announces). */
export async function putTransportConfig(
  id: SourceId,
  config: Record<string, unknown>,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "transport-config",
      trigger,
      inputSummary: `${id} settings`,
    },
    async (trace) => {
      const row = await getTransport(id, db);
      if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
      const updated = await db
        .update(transports)
        .set({ config, updatedAt: new Date() })
        .where(eq(transports.id, id))
        .returning();
      await trace.event({ type: "db", message: `${id} transport config replaced` });
      await announceTransportChange(id);
      await trace.succeed({ outputSummary: `${id} config saved` });
      return updated[0];
    },
  );
}

/** Toggle a transport (a disabled one gets no state and its events are stale). */
export async function setTransportEnabled(
  id: SourceId,
  enabled: boolean,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "transport-toggle",
      trigger,
      inputSummary: `${id} → ${enabled ? "enabled" : "disabled"}`,
    },
    async (trace) => {
      const rows = await db
        .update(transports)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(transports.id, id))
        .returning();
      if (!rows[0]) throw ApiError.notFound(`transport "${id}" is not registered`);
      await announceTransportChange(id);
      await trace.succeed();
      return rows[0];
    },
  );
}

// ---- Per-assistant connections ---------------------------------------------

/** One assistant's connection on one transport, or null. */
/** One connection row by its id, or null — the ownership gates read this. */
export async function getAssistantTransportById(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow | null> {
  const rows = await db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAssistantTransport(
  transport: SourceId,
  assistantId: string,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow | null> {
  const rows = await db
    .select()
    .from(assistantTransports)
    .where(
      and(
        eq(assistantTransports.transport, transport),
        eq(assistantTransports.assistantId, assistantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Every connection on one transport, oldest first. */
export async function listAssistantTransports(
  transport: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow[]> {
  return db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.transport, transport))
    .orderBy(asc(assistantTransports.createdAt));
}

/**
 * Connect an assistant to a transport. Enabled on creation: a saved config
 * means "run this" (v1 autostart semantics); Stop is the explicit way to
 * keep it parked. One connection per assistant per transport.
 */
export async function createAssistantTransport(
  input: { transport: SourceId; assistantId: string; config: Record<string, unknown> },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "connection-create",
      assistantId: input.assistantId,
      trigger,
      inputSummary: `${input.transport} connection`,
    },
    async (trace) => {
      const existing = await getAssistantTransport(input.transport, input.assistantId, db);
      if (existing) {
        throw ApiError.conflict("this assistant already has a connection on this transport");
      }
      const rows = await db
        .insert(assistantTransports)
        .values({
          id: randomUUID(),
          transport: input.transport,
          assistantId: input.assistantId,
          config: input.config,
          enabled: true,
        })
        .returning();
      await trace.event({ type: "db", message: "connection stored (config is the transport's)" });
      await announceTransportChange(input.transport);
      await trace.succeed({ outputSummary: "connection created" });
      return rows[0];
    },
  );
}

/** Desired-state change (re-config, start/stop); the transport reconciles. */
export async function updateAssistantTransport(
  id: string,
  patch: { config?: Record<string, unknown>; enabled?: boolean },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "connection-update",
      trigger,
      inputSummary: Object.keys(patch).join(", "),
    },
    async (trace) => {
      const current = await db
        .select()
        .from(assistantTransports)
        .where(eq(assistantTransports.id, id))
        .limit(1);
      if (!current[0]) throw ApiError.notFound("connection not found");
      const rows = await db
        .update(assistantTransports)
        .set({
          ...(patch.config ? { config: { ...current[0].config, ...patch.config } } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(assistantTransports.id, id))
        .returning();
      await announceTransportChange(rows[0].transport as SourceId);
      await trace.succeed();
      return rows[0];
    },
  );
}

/** Remove a connection: the row, its stored config, and (via the announce) its runtime. */
export async function deleteAssistantTransport(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "connection-delete", trigger, inputSummary: id },
    async (trace) => {
      const rows = await db
        .delete(assistantTransports)
        .where(eq(assistantTransports.id, id))
        .returning();
      if (!rows[0]) throw ApiError.notFound("connection not found");
      await announceTransportChange(rows[0].transport as SourceId);
      await trace.succeed({ outputSummary: "connection removed" });
    },
  );
}

// ---- Operator views --------------------------------------------------------

/** Live poller state one transport reports for one connection. */
export interface TransportConnectionStatus {
  state: "running" | "error" | "stopped";
  username: string | null;
  since: string | null;
  error: string | null;
}

/** One connection as the dashboard renders it (config as masked preview). */
export interface TransportConnectionView {
  id: string;
  assistantId: string;
  enabled: boolean;
  /** Per schema field: the stored value, secrets reduced to a hint. */
  configPreview: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  status: TransportConnectionStatus | null;
}

const STATUS_TIMEOUT_MS = 5_000;

/** The live statuses a transport reports (its /health), keyed by connection id. */
export async function fetchTransportStatuses(
  row: TransportRow,
): Promise<Map<string, TransportConnectionStatus>> {
  if (!row.baseUrl) return new Map();
  try {
    const res = await fetch(`${row.baseUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return new Map();
    const body = (await res.json()) as {
      connections?: {
        connectionId: string;
        state: TransportConnectionStatus["state"];
        username: string | null;
        since: string | null;
        error: string | null;
      }[];
    };
    return new Map(
      (body.connections ?? []).map((status) => [
        status.connectionId,
        {
          state: status.state,
          username: status.username,
          since: status.since,
          error: status.error,
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

/** Mask one config blob against the transport's field schema. */
export function previewConfig(
  config: Record<string, unknown>,
  fields: TransportRow["connectionConfigSchema"],
): Record<string, string> {
  const preview: Record<string, string> = {};
  for (const field of fields) {
    const value = config[field.key];
    if (value == null || value === "") continue;
    preview[field.key] =
      field.kind === "secret" ? `…${String(value).slice(-4)}` : String(value);
  }
  return preview;
}

/** One transport's connections joined with its live poller state. */
export async function listConnectionViews(
  transport: SourceId,
  assistantId?: string,
  db: StoreDb = getStoreDb(),
): Promise<TransportConnectionView[]> {
  const row = await getTransport(transport, db);
  if (!row) return [];
  const [connections, statuses] = await Promise.all([
    listAssistantTransports(transport, db),
    fetchTransportStatuses(row),
  ]);
  return connections
    .filter((connection) => !assistantId || connection.assistantId === assistantId)
    .map((connection) => ({
      id: connection.id,
      assistantId: connection.assistantId,
      enabled: connection.enabled,
      configPreview: previewConfig(connection.config, row.connectionConfigSchema),
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
      status: statuses.get(connection.id) ?? null,
    }));
}
