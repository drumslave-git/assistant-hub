import "server-only";

import { randomUUID } from "node:crypto";

import { isSafePublicUrl } from "@/features/link-fetch/url-safety";
import { ApiError } from "@/lib/api-error";
import { getAccountById } from "@/server/auth/accounts";
import { FEATURES } from "@/lib/features";
import { isRestricted, mayActOn, ownedAssistantIds, type Actor } from "@/server/ownership";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import { diffToolsets, type ComparableTool, type ToolsetDiff } from "./diff";
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
 *
 * Ownership (Phase 9): every connection an account creates is that
 * account's; admins see and manage everything, a user-role account only its
 * own. A USER-owned connection is restricted — it may scope only to its
 * owner's assistants (never global / all-assistants / per-app) and may
 * target public addresses only, checked here and again at call time.
 */

const FEATURE = FEATURES["tool-connections"];

/** The applied snapshot in the shape the diff compares. */
export function appliedTools(record: ToolConnectionRecord): ComparableTool[] {
  return record.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * A connection's stored discovery against its applied snapshot, or null when
 * nothing has been discovered yet. Computed on read rather than stored: it is
 * a comparison of two columns, and a stored copy could disagree with both.
 */
export function driftOf(record: ToolConnectionRecord): ToolsetDiff | null {
  if (!record.discoveredTools) return null;
  return diffToolsets(appliedTools(record), record.discoveredTools);
}

/** Strip secrets: header names survive, values never leave the server. */
export function toClient(record: ToolConnectionRecord): ToolConnection {
  const { authHeaders, ...rest } = record;
  return {
    ...rest,
    authHeaderNames: Object.keys(authHeaders).sort(),
    drift: driftOf(record),
  };
}

/** The actor's connections, oldest first, without secrets. */
export async function getToolConnections(
  actor: Actor | null = null,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection[]> {
  const records = await listToolConnections(db);
  const visible = isRestricted(actor)
    ? records.filter((record) => record.ownerAccountId === actor.id)
    : records;
  return visible.map(toClient);
}

/** One connection by id, without secrets, or null (unowned reads as absent). */
export async function getToolConnection(
  id: string,
  actor: Actor | null = null,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection | null> {
  const record = await getToolConnectionById(db, id);
  if (!record || !mayActOn(actor, record.ownerAccountId)) return null;
  return toClient(record);
}

/**
 * Gate one connection for a mutation: unknown and not-yours both answer
 * not-found, so the scoped API does not leak which ids exist.
 */
async function requireOwnConnection(
  db: StoreDb,
  id: string,
  actor: Actor | null,
): Promise<ToolConnectionRecord> {
  const record = await getToolConnectionById(db, id);
  if (!record || !mayActOn(actor, record.ownerAccountId)) {
    throw ApiError.notFound("Unknown tool connection");
  }
  return record;
}

/**
 * The Phase 9 restrictions on a USER-owned connection, applied to the shape
 * a create/update would leave behind: its scope may name only the owner's
 * assistants (never everyone, never a whole app), and its endpoint must be
 * a public address — the core makes the calls, so a private-range URL would
 * be an SSRF hole, rejected here and again at call time.
 */
async function assertUserConnectionRules(
  db: StoreDb,
  /** The account that OWNS (or will own) the connection — never the actor. */
  ownerAccountId: string,
  next: {
    endpointUrl: string;
    appScope: string | null;
    allAssistants: boolean;
    assistantIds: readonly string[];
  },
): Promise<void> {
  if (!isSafePublicUrl(next.endpointUrl)) {
    throw ApiError.badRequest(
      "User connections may target public addresses only (no localhost or private ranges)",
    );
  }
  if (next.appScope != null) {
    throw ApiError.badRequest("User connections cannot be scoped to an app");
  }
  if (next.allAssistants) {
    throw ApiError.badRequest("User connections must select specific assistants of your own");
  }
  const owned = (await ownedAssistantIds({ id: ownerAccountId, role: "user" }, db))!;
  const foreign = next.assistantIds.filter((id) => !owned.has(id));
  if (foreign.length > 0) {
    throw ApiError.badRequest("User connections may only serve your own assistants");
  }
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

/**
 * Whether a connection is Phase 9-restricted: owned by an account whose
 * CURRENT role is `user`. Judged live, so demotions take effect without a
 * data migration.
 */
export async function connectionIsRestricted(
  db: StoreDb,
  record: Pick<ToolConnectionRecord, "ownerAccountId">,
): Promise<boolean> {
  if (!record.ownerAccountId) return false;
  const owner = await getAccountById(record.ownerAccountId, db);
  return owner?.role === "user";
}

/** The public-address half of the restriction, at any point the core dials. */
export async function assertPublicWhenUserOwned(
  db: StoreDb,
  record: Pick<ToolConnectionRecord, "ownerAccountId" | "endpointUrl" | "name">,
): Promise<void> {
  if ((await connectionIsRestricted(db, record)) && !isSafePublicUrl(record.endpointUrl)) {
    throw ApiError.badRequest(
      `"${record.name}" targets a private address — user connections may reach public addresses only`,
    );
  }
}

/** Create a connection, recorded as a trace. */
export async function createToolConnection(
  input: CreateToolConnection,
  trigger: TraceTrigger,
  actor: Actor | null = null,
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
      if (isRestricted(actor)) {
        await assertUserConnectionRules(db, actor.id, input);
      }

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
        // The creator owns what they create (Phase 9); null only while
        // auth is unconfigured.
        ownerAccountId: actor?.id ?? null,
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
  actor: Actor | null = null,
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
      const existing = await requireOwnConnection(db, id, actor);
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
      // The restrictions follow the OWNER's current role, not the actor's:
      // an admin editing a user's connection cannot walk it out of the
      // rules either. Judge the shape the update would LEAVE.
      if (existing.ownerAccountId && (await connectionIsRestricted(db, existing))) {
        await assertUserConnectionRules(db, existing.ownerAccountId, {
          endpointUrl: input.endpointUrl ?? existing.endpointUrl,
          appScope: input.appScope !== undefined ? input.appScope : existing.appScope,
          allAssistants:
            input.allAssistants !== undefined ? input.allAssistants : existing.allAssistants,
          assistantIds: assistantIds ?? existing.assistantIds,
        });
      }

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
  actor: Actor | null = null,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `connection ${id}` },
    async (trace) => {
      const existing = await requireOwnConnection(db, id, actor);
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
