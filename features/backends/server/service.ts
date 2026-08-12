import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { clearRoleModelsNotServed } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { listModels } from "@/server/llm/client";
import { withTrace } from "@/server/trace";
import {
  deleteBackend,
  getBackendById,
  insertBackend,
  isNameTaken,
  listBackends,
  updateBackend,
  type BackendRecord,
} from "./repository";
import type { Backend, CreateBackend, TestBackend, UpdateBackend } from "./schema";

/**
 * Backends domain service — the boundary the Route Handlers, the Backends page,
 * and the settings service call. Owns validation (case-insensitive name
 * uniqueness), the in-use delete guard, secret masking, and trace recording for
 * every mutation. Reads are cheap and untraced.
 */

const FEATURE = FEATURES["backends"];

/** Short timeout so page loads stay responsive against a dead endpoint. */
const MODELS_PRELOAD_TIMEOUT_MS = 5_000;

/** Project a stored record to the client-safe shape (masking the secret). */
function toClient(record: BackendRecord): Backend {
  return {
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    type: record.type,
    apiKeyConfigured: Boolean(record.apiKey),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** All backends (oldest first), client-safe. */
export async function getBackends(db: DrizzleDb = getDb()): Promise<Backend[]> {
  return (await listBackends(db)).map(toClient);
}

/** One backend, client-safe, or null. */
export async function getBackend(id: string, db: DrizzleDb = getDb()): Promise<Backend | null> {
  const record = await getBackendById(db, id);
  return record ? toClient(record) : null;
}

/**
 * The settings roles explicitly pointing at a backend — what would break if the
 * row vanished, which makes it both the delete guard's evidence and useful
 * context on the Backends page. Roles that merely inherit the chat backend are
 * not listed: they follow whatever chat points at, and chat itself is.
 */
export async function rolesUsingBackend(id: string, db: DrizzleDb = getDb()): Promise<string[]> {
  const record = await getSettingsRecord(db);
  if (!record) return [];
  const refs: Array<[string | null, string]> = [
    [record.chatBackendId, "chat"],
    [record.embeddingBackendId, "embedding"],
    [record.imageBackendId, "image generation"],
    [record.speechBackendId, "speech"],
    [record.audioBackendId, "audio"],
    [record.visionBackendId, "vision"],
    [record.browserBackendId, "browser agent"],
  ];
  return refs.filter(([ref]) => ref === id).map(([, role]) => role);
}

/** Redact the secret before trace storage. */
function redact(input: CreateBackend | UpdateBackend): Record<string, unknown> {
  const { apiKey, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
  if (apiKey !== undefined) out.apiKey = "«redacted»";
  return out;
}

/** Create a backend, recorded as a trace. */
export async function createBackend(
  input: CreateBackend,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Backend> {
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.name },
    async (trace) => {
      await trace.event({ type: "input", message: "create backend", data: redact(input) });
      if (await isNameTaken(db, input.name)) {
        throw ApiError.conflict(`A backend named "${input.name}" already exists`);
      }
      const record = await insertBackend(db, randomUUID(), {
        name: input.name,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey || null,
        type: input.type,
      });
      await trace.event({ type: "db", message: "backend created" });
      await trace.succeed({
        outputSummary: `${record.name} (${record.baseUrl})`,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      return toClient(record);
    },
  );
}

/**
 * Apply a validated update to a backend, recorded as a trace.
 *
 * Repointing a backend's URL repoints every role using it, so the same
 * stale-model doctrine as a settings save applies: the new endpoint is listed
 * once and any role model selection it verifiably does not serve is cleared in
 * the same operation (never on unproven absence — a failed listing clears
 * nothing; audio is exempt, whisper-class servers often list nothing).
 */
export async function editBackend(
  id: string,
  input: UpdateBackend,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ backend: Backend; clearedModels: string[] }> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `backend ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update backend", data: { id, ...redact(input) } });
      const existing = await getBackendById(db, id);
      if (!existing) throw ApiError.notFound("Unknown backend");
      if (input.name !== undefined && (await isNameTaken(db, input.name, id))) {
        throw ApiError.conflict(`A backend named "${input.name}" already exists`);
      }
      const patch: Parameters<typeof updateBackend>[2] = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
      if (input.apiKey !== undefined) patch.apiKey = input.apiKey || null;
      if (input.type !== undefined) patch.type = input.type;
      const record = await updateBackend(db, id, patch);
      if (!record) throw ApiError.notFound("Unknown backend");
      await trace.event({ type: "db", message: "backend updated" });

      const repointed =
        (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) ||
        (input.apiKey !== undefined && (input.apiKey || null) !== existing.apiKey);
      const clearedModels = repointed ? await clearRoleModelsNotServed(record, trace, db) : [];

      await trace.succeed({
        outputSummary:
          clearedModels.length > 0
            ? `${record.name}; cleared stale ${clearedModels.join(", ")}`
            : record.name,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      return { backend: toClient(record), clearedModels };
    },
  );
}

/**
 * Delete a backend, recorded as a trace. Refused (409) while any settings role
 * points at it — the error names the roles so the operator knows what to repoint
 * first. The FK is `on delete restrict` as a backstop; this check is what turns
 * it into a readable answer.
 */
export async function removeBackend(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `backend ${id}` },
    async (trace) => {
      const referencing = await rolesUsingBackend(id, db);
      if (referencing.length > 0) {
        throw ApiError.conflict(
          `This backend is in use by: ${referencing.join(", ")}. Repoint those roles in Settings first.`,
        );
      }
      const deleted = await deleteBackend(db, id);
      if (!deleted) throw ApiError.notFound("Unknown backend");
      await trace.event({ type: "db", message: "backend deleted" });
      await trace.succeed({ outputSummary: `deleted ${id}`, relatedIds: { [FEATURE.relatedIdsKey]: [id] } });
    },
  );
}

/**
 * Test a backend connection by listing its models — proves the host answers,
 * the key (stored or just typed) is accepted, and gives the operator the model
 * preview in one call. Recorded as a trace. Throws a clean `ApiError` on an
 * unreachable endpoint so the form can show why.
 */
export async function testBackend(
  input: TestBackend,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ models: string[] }> {
  const stored = input.backendId ? await getBackendById(db, input.backendId) : null;
  if (input.backendId && !stored) throw ApiError.notFound("Unknown backend");
  const baseUrl = input.baseUrl ?? stored?.baseUrl;
  if (!baseUrl) throw ApiError.badRequest("Provide a base URL to test");
  const apiKey = input.apiKey !== undefined ? input.apiKey : (stored?.apiKey ?? null);

  return withTrace(
    { feature: FEATURE.id, action: "test-connection", trigger, inputSummary: baseUrl },
    async (trace) => {
      await trace.event({ type: "external_call", message: `GET ${baseUrl} /models` });
      const models = await listModels({ baseUrl, apiKey, backend: stored?.type });
      await trace.event({ type: "output", message: `${models.length} models returned` });
      await trace.succeed({ outputSummary: `${models.length} models` });
      return { models };
    },
  );
}

/**
 * The models a stored backend serves — feeds the Settings role dropdowns.
 * Throws a clean `ApiError` on an unreachable endpoint (the form shows why the
 * list is empty); use {@link preloadBackendModels} for the never-throw variant.
 */
export async function listBackendModels(
  backendId: string,
  db: DrizzleDb = getDb(),
): Promise<{ models: string[] }> {
  const record = await getBackendById(db, backendId);
  if (!record) throw ApiError.notFound("Unknown backend");
  const models = await listModels(
    { baseUrl: record.baseUrl, apiKey: record.apiKey, backend: record.type },
    MODELS_PRELOAD_TIMEOUT_MS,
  );
  return { models };
}

/**
 * Best-effort model lists for every stored backend, keyed by backend id — the
 * Settings page preload, so role dropdowns are populated on open without a
 * manual test. Endpoints are listed concurrently and an unreachable one yields
 * an empty list (never throws).
 */
export async function preloadBackendModels(
  db: DrizzleDb = getDb(),
): Promise<Record<string, string[]>> {
  const records = await listBackends(db);
  const entries = await Promise.all(
    records.map(async (record) => {
      try {
        const models = await listModels(
          { baseUrl: record.baseUrl, apiKey: record.apiKey, backend: record.type },
          MODELS_PRELOAD_TIMEOUT_MS,
        );
        return [record.id, models] as const;
      } catch {
        return [record.id, []] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
