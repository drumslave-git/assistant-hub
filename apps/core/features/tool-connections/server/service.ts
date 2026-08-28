import "server-only";

import { randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import {
  countToolConnections,
  deleteToolConnection,
  getToolConnectionById,
  insertToolConnection,
  isSlugTaken,
  listToolConnections,
  setAssistantSelection,
  updateToolConnection,
  type ToolConnectionRecord,
} from "./repository";
import {
  MAX_CONNECTIONS,
  type CreateToolConnection,
  type ToolConnection,
  type UpdateToolConnection,
} from "./schema";

/**
 * Tool-connections domain service — the boundary Route Handlers, the
 * dashboard and the toolset resolver call. Owns validation (slug
 * uniqueness, the max-count guard, the transports v2 actually executes),
 * secret masking, trace recording for every mutation and live-refresh
 * publishing. Reads are cheap and untraced.
 *
 * What it deliberately does NOT do: change what the model is offered.
 * Editing a connection can only take its tools away (disable, re-scope) —
 * the snapshot itself moves on an explicit apply (user decision,
 * 2026-08-28).
 */

const FEATURE = FEATURES["tool-connections"];

/** Strip secrets: header names survive, values never leave the server. */
export function toClient(record: ToolConnectionRecord): ToolConnection {
  const { authHeaders, ...rest } = record;
  return { ...rest, authHeaderNames: Object.keys(authHeaders).sort() };
}

/** Every connection, oldest first, without secrets. */
export async function getToolConnections(db: StoreDb = getStoreDb()): Promise<ToolConnection[]> {
  return (await listToolConnections(db)).map(toClient);
}

/** One connection by id, without secrets, or null. */
export async function getToolConnection(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection | null> {
  const record = await getToolConnectionById(db, id);
  return record ? toClient(record) : null;
}

/**
 * `stdio` is modeled in the schema so the discriminator and UI need no
 * rework when it lands, but nothing executes it in v2 — so it is refused at
 * the boundary rather than accepted into a row that could never run.
 */
function assertExecutableTransport(transport: string): void {
  if (transport !== "http") {
    throw ApiError.badRequest("Only http connections are supported in this version");
  }
}

/** Managed connections are reconciled from configuration, not operator-owned. */
function assertNotManaged(record: ToolConnectionRecord, what: string): void {
  if (record.managed) {
    throw ApiError.conflict(`"${record.name}" is provided by the hub and cannot be ${what}`);
  }
}

/**
 * What an assistant selection may reference. An unknown id would be a
 * foreign-key error at insert time; catching it here says which id.
 */
async function assertKnownAssistants(db: StoreDb, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const known = new Set((await db.query.assistants.findMany()).map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw ApiError.badRequest(`Unknown assistant: ${unknown[0]}`);
}

/** Create a connection, recorded as a trace. */
export async function createToolConnection(
  input: CreateToolConnection,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection> {
  const id = randomUUID();
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.slug },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "create tool connection",
        // Header VALUES are the one thing withheld from a trace body: a
        // bearer token pasted into Debug is a leaked credential.
        data: {
          slug: input.slug,
          name: input.name,
          transport: input.transport,
          endpointUrl: input.endpointUrl,
          authHeaderNames: Object.keys(input.authHeaders),
          appScope: input.appScope,
          allAssistants: input.allAssistants,
          assistantIds: input.assistantIds,
          enabled: input.enabled,
        },
      });
      assertExecutableTransport(input.transport);
      if ((await countToolConnections(db)) >= MAX_CONNECTIONS) {
        throw ApiError.conflict(`At most ${MAX_CONNECTIONS} tool connections are allowed`);
      }
      if (await isSlugTaken(db, input.slug)) {
        throw ApiError.conflict(`A connection with slug "${input.slug}" already exists`);
      }
      await assertKnownAssistants(db, input.assistantIds);

      const record = await insertToolConnection(db, id, {
        slug: input.slug,
        name: input.name,
        transport: input.transport,
        endpointUrl: input.endpointUrl,
        authHeaders: input.authHeaders,
        enabled: input.enabled,
        appScope: input.appScope,
        allAssistants: input.allAssistants,
        managed: false,
      });
      await setAssistantSelection(db, id, input.assistantIds);
      await trace.event({
        type: "db",
        message: "connection created — no tools are offered until discovery is applied",
      });
      await trace.succeed({
        outputSummary: record.slug,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
      const stored = await getToolConnectionById(db, id);
      return toClient(stored ?? record);
    },
  );
}

/** Apply a validated update to a connection, recorded as a trace. */
export async function editToolConnection(
  id: string,
  input: UpdateToolConnection,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `connection ${id}` },
    async (trace) => {
      const { authHeaders, assistantIds, ...loggable } = input;
      await trace.event({
        type: "input",
        message: "update tool connection",
        data: {
          id,
          ...loggable,
          ...(authHeaders ? { authHeaderNames: Object.keys(authHeaders) } : {}),
          ...(assistantIds ? { assistantIds } : {}),
        },
      });
      const existing = await getToolConnectionById(db, id);
      if (!existing) throw ApiError.notFound("Unknown tool connection");
      // A managed connection's identity and endpoint are configuration; its
      // scope and enabled flag are the operator's, so only the former are
      // refused rather than the whole edit.
      if (
        existing.managed &&
        (input.slug !== undefined ||
          input.endpointUrl !== undefined ||
          input.authHeaders !== undefined ||
          input.name !== undefined)
      ) {
        assertNotManaged(existing, "renamed or re-pointed");
      }
      if (input.slug !== undefined && (await isSlugTaken(db, input.slug, id))) {
        throw ApiError.conflict(`A connection with slug "${input.slug}" already exists`);
      }
      if (assistantIds) await assertKnownAssistants(db, assistantIds);

      const record = await updateToolConnection(db, id, {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.endpointUrl !== undefined ? { endpointUrl: input.endpointUrl } : {}),
        ...(authHeaders !== undefined ? { authHeaders } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.appScope !== undefined ? { appScope: input.appScope } : {}),
        ...(input.allAssistants !== undefined ? { allAssistants: input.allAssistants } : {}),
      });
      if (!record) throw ApiError.notFound("Unknown tool connection");
      if (assistantIds) await setAssistantSelection(db, id, assistantIds);
      await trace.event({ type: "db", message: "connection updated" });
      await trace.succeed({
        outputSummary: record.slug,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
      const stored = await getToolConnectionById(db, id);
      return toClient(stored ?? record);
    },
  );
}

/** Delete a connection; its snapshot and assistant selection cascade. */
export async function removeToolConnection(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `connection ${id}` },
    async (trace) => {
      const existing = await getToolConnectionById(db, id);
      if (!existing) throw ApiError.notFound("Unknown tool connection");
      assertNotManaged(existing, "deleted");
      await deleteToolConnection(db, id);
      await trace.event({
        type: "db",
        message: `connection deleted — ${existing.tools.length} offered tools withdrawn`,
      });
      await trace.succeed({
        outputSummary: `deleted ${existing.slug}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
    },
  );
}
