import "server-only";

import type { SourceId } from "@assistant-hub/contracts";
import { asc, eq, ne, sql } from "drizzle-orm";

import {
  assistantToolConnections,
  toolConnections,
  toolConnectionTools,
  type ToolConnectionRow,
  type ToolConnectionToolRow,
} from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";
import type { ComparableTool } from "./diff";
import type { ToolTransport } from "./schema";

/**
 * Typed persistence for MCP tool connections, their applied tool snapshot,
 * and the per-assistant selection. Pure data access: no validation, no
 * secret masking, no trace recording — the service owns those.
 */

/** One tool of the applied snapshot. */
export interface ConnectionToolRecord {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  appliedAt: string;
}

/** A connection as stored, with its snapshot and assistant selection. */
export interface ToolConnectionRecord {
  id: string;
  slug: string;
  name: string;
  transport: ToolTransport;
  endpointUrl: string;
  /** Secret: the service never returns these values to a client. */
  authHeaders: Record<string, string>;
  enabled: boolean;
  appScope: SourceId | null;
  allAssistants: boolean;
  assistantIds: string[];
  managed: boolean;
  /** The owning account (Phase 9), or null for managed/system rows. */
  ownerAccountId: string | null;
  lastDiscoveredAt: string | null;
  lastError: string | null;
  /** What the last discovery saw — not what the model is offered. */
  discoveredTools: ComparableTool[] | null;
  /** The applied snapshot: exactly what the model is offered. */
  tools: ConnectionToolRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Columns a create/update may set. */
export interface ToolConnectionValues {
  slug: string;
  name: string;
  transport: ToolTransport;
  endpointUrl: string;
  authHeaders: Record<string, string>;
  enabled: boolean;
  appScope: SourceId | null;
  allAssistants: boolean;
  managed: boolean;
  ownerAccountId: string | null;
}

function mapTool(row: ToolConnectionToolRow): ConnectionToolRecord {
  return {
    name: row.name,
    description: row.description ?? "",
    inputSchema: row.inputSchema,
    appliedAt: row.appliedAt.toISOString(),
  };
}

function mapRow(
  row: ToolConnectionRow,
  tools: ToolConnectionToolRow[],
  assistantIds: string[],
): ToolConnectionRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    transport: row.transport as ToolTransport,
    endpointUrl: row.endpointUrl,
    authHeaders: row.authHeaders,
    enabled: row.enabled,
    appScope: row.appScope as SourceId | null,
    allAssistants: row.allAssistants,
    assistantIds,
    managed: row.managed,
    ownerAccountId: row.ownerAccountId,
    lastDiscoveredAt: row.lastDiscoveredAt?.toISOString() ?? null,
    lastError: row.lastError,
    discoveredTools: row.lastDiscoveredTools ?? null,
    tools: tools.filter((tool) => tool.connectionId === row.id).map(mapTool),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every connection with its snapshot and selection, oldest first. Three
 * reads rather than a join: the snapshot and the selection are both
 * one-to-many, and joining them together would multiply rows.
 */
export async function listToolConnections(db: StoreDb): Promise<ToolConnectionRecord[]> {
  const [rows, tools, members] = await Promise.all([
    db.query.toolConnections.findMany({ orderBy: [asc(toolConnections.createdAt)] }),
    db.query.toolConnectionTools.findMany({ orderBy: [asc(toolConnectionTools.name)] }),
    db.query.assistantToolConnections.findMany(),
  ]);
  return rows.map((row) =>
    mapRow(
      row,
      tools,
      members.filter((member) => member.connectionId === row.id).map((m) => m.assistantId),
    ),
  );
}

/** One connection by id, or null. */
export async function getToolConnectionById(
  db: StoreDb,
  id: string,
): Promise<ToolConnectionRecord | null> {
  const row = await db.query.toolConnections.findFirst({ where: eq(toolConnections.id, id) });
  if (!row) return null;
  const [tools, members] = await Promise.all([
    db.query.toolConnectionTools.findMany({
      where: eq(toolConnectionTools.connectionId, id),
      orderBy: [asc(toolConnectionTools.name)],
    }),
    db.query.assistantToolConnections.findMany({
      where: eq(assistantToolConnections.connectionId, id),
    }),
  ]);
  return mapRow(row, tools, members.map((member) => member.assistantId));
}

/** One connection by slug, or null (slug is the model-visible handle). */
export async function getToolConnectionBySlug(
  db: StoreDb,
  slug: string,
): Promise<ToolConnectionRecord | null> {
  const row = await db.query.toolConnections.findFirst({ where: eq(toolConnections.slug, slug) });
  return row ? getToolConnectionById(db, row.id) : null;
}

/** Total number of connections (for the max-count guard). */
export async function countToolConnections(db: StoreDb): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(toolConnections);
  return rows[0]?.n ?? 0;
}

/** Whether a slug is taken, optionally excluding one id (for renames). */
export async function isSlugTaken(db: StoreDb, slug: string, exceptId?: string): Promise<boolean> {
  const match = eq(toolConnections.slug, slug);
  const where = exceptId ? sql`${match} and ${ne(toolConnections.id, exceptId)}` : match;
  const rows = await db.select({ id: toolConnections.id }).from(toolConnections).where(where).limit(1);
  return rows.length > 0;
}

/** Insert a connection with an app-generated id. */
export async function insertToolConnection(
  db: StoreDb,
  id: string,
  values: ToolConnectionValues,
): Promise<ToolConnectionRecord> {
  const now = new Date();
  await db.insert(toolConnections).values({ id, ...values, createdAt: now, updatedAt: now });
  const record = await getToolConnectionById(db, id);
  if (!record) throw new Error(`tool connection ${id} vanished after insert`);
  return record;
}

/** Apply a patch to one connection. Returns the updated record, or null. */
export async function updateToolConnection(
  db: StoreDb,
  id: string,
  patch: Partial<ToolConnectionValues>,
): Promise<ToolConnectionRecord | null> {
  const rows = await db
    .update(toolConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(toolConnections.id, id))
    .returning({ id: toolConnections.id });
  if (rows.length === 0) return null;
  return getToolConnectionById(db, id);
}

/**
 * Record a discovery outcome. Never touches the applied snapshot — that is
 * the whole rule (user decision, 2026-08-28). A failed discovery leaves the
 * previously seen toolset in place and only records why it failed, so the
 * dashboard keeps showing the last thing that was true.
 */
export async function recordDiscovery(
  db: StoreDb,
  id: string,
  outcome: { at: Date | null; error: string | null; tools?: readonly ComparableTool[] },
): Promise<void> {
  await db
    .update(toolConnections)
    .set({
      lastDiscoveredAt: outcome.at,
      lastError: outcome.error,
      ...(outcome.tools ? { lastDiscoveredTools: [...outcome.tools] } : {}),
    })
    .where(eq(toolConnections.id, id));
}

/** Delete one connection; its snapshot and selection cascade. */
export async function deleteToolConnection(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db
    .delete(toolConnections)
    .where(eq(toolConnections.id, id))
    .returning({ id: toolConnections.id });
  return rows.length > 0;
}

/** Replace one connection's assistant selection with exactly these ids. */
export async function setAssistantSelection(
  db: StoreDb,
  connectionId: string,
  assistantIds: readonly string[],
): Promise<void> {
  await db
    .delete(assistantToolConnections)
    .where(eq(assistantToolConnections.connectionId, connectionId));
  if (assistantIds.length === 0) return;
  await db
    .insert(assistantToolConnections)
    .values(assistantIds.map((assistantId) => ({ connectionId, assistantId })));
}

/**
 * Replace one connection's applied snapshot with exactly these tools — the
 * only write that changes what the model is offered (user decision,
 * 2026-08-28: discovery reports, an apply moves the snapshot).
 */
export async function replaceSnapshot(
  db: StoreDb,
  connectionId: string,
  tools: readonly Omit<ConnectionToolRecord, "appliedAt">[],
): Promise<void> {
  await db
    .delete(toolConnectionTools)
    .where(eq(toolConnectionTools.connectionId, connectionId));
  if (tools.length === 0) return;
  await db.insert(toolConnectionTools).values(
    tools.map((tool) => ({
      connectionId,
      name: tool.name,
      description: tool.description || null,
      inputSchema: tool.inputSchema,
      appliedAt: new Date(),
    })),
  );
}
