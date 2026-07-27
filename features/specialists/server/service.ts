import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { isGroupChatId } from "@/lib/telegram";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { withTrace } from "@/server/trace";
import {
  browseEntries,
  countSpecialists,
  deleteChatSpecialist,
  deleteEntryInScope,
  deleteSpecialist,
  getChatSpecialist,
  getEntryInScope,
  getSpecialistById,
  getSpecialistByName,
  insertEntry,
  insertSpecialist,
  isNameTaken,
  listChatSpecialists,
  listCollections,
  listSpecialists,
  queryEntries,
  updateEntryInScope,
  updateSpecialist,
  upsertChatSpecialist,
  type EntryScope,
  type SpecialistEntryRecord,
  type SpecialistRecord,
} from "./repository";
import {
  MAX_ENTRY_PAYLOAD_BYTES,
  MAX_QUERY_RESULTS,
  MAX_SPECIALISTS,
  type ChatSpecialist,
  type CreateSpecialist,
  type ListEntriesQuery,
  type Specialist,
  type SpecialistEntry,
  type UpdateSpecialist,
} from "./schema";

/**
 * Specialists domain service — the boundary Route Handlers, Server Components,
 * the bot runtime, and the MCP toolkit call. Owns validation (name uniqueness,
 * the max-count guard, the entry payload cap), per-chat activation policy (the
 * switch permission gate), entry-scope resolution from the specialist's
 * data-scope flag, and trace recording for every mutation. Reads are cheap and
 * untraced.
 */

const FEATURE = FEATURES["specialists"];

/** A stored record is already client-safe. */
function toClient(record: SpecialistRecord): Specialist {
  return record;
}

/** The specialists list plus every chat activation (the dashboard view). */
export interface SpecialistsView {
  specialists: Specialist[];
  assignments: ChatSpecialist[];
}

/** All specialists (oldest first) and the chat activations. */
export async function getSpecialistsView(db: DrizzleDb = getDb()): Promise<SpecialistsView> {
  const [records, assignments] = await Promise.all([
    listSpecialists(db),
    listChatSpecialists(db),
  ]);
  return { specialists: records.map(toClient), assignments };
}

/** One specialist by id, or null. */
export async function getSpecialist(
  id: string,
  db: DrizzleDb = getDb(),
): Promise<Specialist | null> {
  const record = await getSpecialistById(db, id);
  return record ? toClient(record) : null;
}

/** Create a specialist, recorded as a trace. */
export async function createSpecialist(
  input: CreateSpecialist,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Specialist> {
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.name },
    async (trace) => {
      await trace.event({ type: "input", message: "create specialist", data: { ...input } });
      if ((await countSpecialists(db)) >= MAX_SPECIALISTS) {
        throw ApiError.conflict(`At most ${MAX_SPECIALISTS} specialists are allowed`);
      }
      if (await isNameTaken(db, input.name)) {
        throw ApiError.conflict(`A specialist named "${input.name}" already exists`);
      }
      const record = await insertSpecialist(db, randomUUID(), input);
      await trace.event({ type: "db", message: "specialist created" });
      await trace.succeed({
        outputSummary: record.name,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return toClient(record);
    },
  );
}

/** Apply a validated update to a specialist, recorded as a trace. */
export async function editSpecialist(
  id: string,
  input: UpdateSpecialist,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Specialist> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `specialist ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update specialist", data: { id, ...input } });
      const existing = await getSpecialistById(db, id);
      if (!existing) throw ApiError.notFound("Unknown specialist");
      if (input.name !== undefined && (await isNameTaken(db, input.name, id))) {
        throw ApiError.conflict(`A specialist named "${input.name}" already exists`);
      }
      const record = await updateSpecialist(db, id, input);
      if (!record) throw ApiError.notFound("Unknown specialist");
      await trace.event({ type: "db", message: "specialist updated" });
      await trace.succeed({
        outputSummary: record.name,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return toClient(record);
    },
  );
}

/**
 * Delete a specialist, recorded as a trace. Chat activations and stored entries
 * cascade away with it (DB `on delete cascade`).
 */
export async function removeSpecialist(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `specialist ${id}` },
    async (trace) => {
      const deleted = await deleteSpecialist(db, id);
      if (!deleted) throw ApiError.notFound("Unknown specialist");
      await trace.event({ type: "db", message: "specialist deleted (activations + entries cascaded)" });
      await trace.succeed({ outputSummary: `deleted ${id}`, relatedIds: { [FEATURE.relatedIdsKey]: [id] } });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

/* ---------------------------- per-chat activation --------------------------- */

/**
 * Set (or clear, with null) a chat's active specialist from the dashboard,
 * recorded as a trace. No permission gate: the dashboard is operator-only.
 */
export async function setChatSpecialist(
  input: { chatId: string; specialistId: string | null },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SpecialistsView> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "assign",
      trigger,
      inputSummary: `chat ${input.chatId} → ${input.specialistId ?? "(none)"}`,
    },
    async (trace) => {
      await trace.event({ type: "input", message: "set chat specialist", data: { ...input } });
      if (input.specialistId) {
        const exists = await getSpecialistById(db, input.specialistId);
        if (!exists) throw ApiError.badRequest("Selected specialist does not exist");
        await upsertChatSpecialist(db, {
          chatId: input.chatId,
          specialistId: input.specialistId,
          activatedByUserId: null,
        });
      } else {
        await deleteChatSpecialist(db, input.chatId);
      }
      await trace.event({ type: "db", message: "chat activation updated" });
      await trace.succeed({
        outputSummary: input.specialistId ? `active ${input.specialistId}` : "cleared",
        relatedIds: input.specialistId
          ? { [FEATURE.relatedIdsKey]: [input.specialistId] }
          : undefined,
      });
      publishEvent(FEATURE.realtimeTopic);
      return getSpecialistsView(db);
    },
  );
}

/** Outcome of a chat-side switch attempt, for the tool to relay. */
export type SwitchResult =
  | { status: "switched"; specialist: Specialist }
  | { status: "cleared" }
  | { status: "denied"; reason: string }
  | { status: "not_found"; name: string };

/**
 * Switch (or clear, with null) the current chat's specialist from a chat turn,
 * recorded as a trace. Permission is enforced here, inside the boundary the
 * tool calls (user decision, 2026-07-27 — the browser-downloads owner-gate
 * precedent): in a private chat the user may switch their own chat's
 * specialist; in a group only the configured owner may. A denial is returned as
 * a result (not thrown) so the model relays the refusal.
 */
export async function switchSpecialistFromChat(
  input: { chatId: string; userId: string | null; specialistName: string | null },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SwitchResult> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "switch",
      trigger,
      inputSummary: `chat ${input.chatId} → ${input.specialistName ?? "(none)"}`,
    },
    async (trace) => {
      await trace.event({ type: "input", message: "switch specialist from chat", data: { ...input } });

      const isGroup = isGroupChatId(input.chatId);
      if (isGroup) {
        const ownerUserId = (await getSettingsRecord(db))?.ownerUserId ?? null;
        if (!ownerUserId || !input.userId || input.userId !== ownerUserId) {
          const result: SwitchResult = {
            status: "denied",
            reason: "Only the bot owner can switch this group's specialist.",
          };
          await trace.event({ type: "step", level: "warn", message: "switch denied (group, not owner)" });
          await trace.succeed({ outputSummary: "denied" });
          return result;
        }
      } else if (!input.userId || input.userId !== input.chatId) {
        // A private chat's id equals the user id; anything else is not "their own DM".
        const result: SwitchResult = {
          status: "denied",
          reason: "You can only switch the specialist of your own chat.",
        };
        await trace.event({ type: "step", level: "warn", message: "switch denied (not own DM)" });
        await trace.succeed({ outputSummary: "denied" });
        return result;
      }

      if (input.specialistName == null) {
        await deleteChatSpecialist(db, input.chatId);
        await trace.event({ type: "db", message: "chat activation cleared" });
        await trace.succeed({ outputSummary: "cleared" });
        publishEvent(FEATURE.realtimeTopic);
        return { status: "cleared" } satisfies SwitchResult;
      }

      const record = await getSpecialistByName(db, input.specialistName);
      if (!record) {
        await trace.event({ type: "step", level: "warn", message: "no such specialist" });
        await trace.succeed({ outputSummary: `not found: ${input.specialistName}` });
        return { status: "not_found", name: input.specialistName } satisfies SwitchResult;
      }
      await upsertChatSpecialist(db, {
        chatId: input.chatId,
        specialistId: record.id,
        activatedByUserId: input.userId,
      });
      await trace.event({ type: "db", message: "chat activation set" });
      await trace.succeed({
        outputSummary: `active ${record.name}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return { status: "switched", specialist: toClient(record) } satisfies SwitchResult;
    },
  );
}

/**
 * Server-only: the chat's active specialist, or null when none is active. Read
 * on every reply (and every scheduled-task fire) for prompt composition, and by
 * the toolkit for scope resolution.
 */
export async function getActiveSpecialist(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<Specialist | null> {
  const assignment = await getChatSpecialist(db, chatId);
  if (!assignment) return null;
  const record = await getSpecialistById(db, assignment.specialistId);
  return record ? toClient(record) : null;
}

/**
 * Server-only: the active specialist's instructions for a chat, or null. The
 * prompt-composition entry point (live reply path and scheduled-fire path).
 */
export async function getActiveSpecialistInstructions(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<string | null> {
  const specialist = await getActiveSpecialist(chatId, db);
  return specialist?.instructions.trim() ? specialist.instructions : null;
}

/* --------------------------------- entries --------------------------------- */

/** The entry scope for a specialist active in a chat, from its data-scope flag. */
export function scopeFor(specialist: Specialist, chatId: string): EntryScope {
  return specialist.dataScope === "shared"
    ? { specialistId: specialist.id }
    : { specialistId: specialist.id, chatId };
}

function assertPayloadWithinCap(payload: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > MAX_ENTRY_PAYLOAD_BYTES) {
    throw ApiError.badRequest(
      `Entry payload is too large (${bytes} bytes; at most ${MAX_ENTRY_PAYLOAD_BYTES}). Store a smaller entry or split it.`,
    );
  }
}

/** Save one entry for the chat's active specialist, recorded as a trace. */
export async function saveEntry(
  input: {
    specialist: Specialist;
    chatId: string;
    authorUserId: string | null;
    collection: string;
    payload: Record<string, unknown>;
  },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SpecialistEntry> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "entry-save",
      trigger,
      inputSummary: `${input.specialist.name} / ${input.collection}`,
    },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "save entry",
        data: { specialistId: input.specialist.id, chatId: input.chatId, collection: input.collection, payload: input.payload },
      });
      assertPayloadWithinCap(input.payload);
      const record = await insertEntry(db, randomUUID(), {
        specialistId: input.specialist.id,
        chatId: input.chatId,
        authorUserId: input.authorUserId,
        collection: input.collection,
        payload: input.payload,
      });
      await trace.event({ type: "db", message: "entry saved", data: { id: record.id } });
      await trace.succeed({
        outputSummary: `entry ${record.id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [input.specialist.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/** Entries in the specialist's scope for this chat, newest first, capped. Untraced read. */
export async function queryEntriesForChat(
  input: {
    specialist: Specialist;
    chatId: string;
    collection?: string;
    contains?: string;
    limit?: number;
  },
  db: DrizzleDb = getDb(),
): Promise<{ entries: SpecialistEntry[]; collections: string[] }> {
  const scope = scopeFor(input.specialist, input.chatId);
  const limit = Math.min(Math.max(input.limit ?? MAX_QUERY_RESULTS, 1), MAX_QUERY_RESULTS);
  const [entries, collections] = await Promise.all([
    queryEntries(db, scope, { collection: input.collection, contains: input.contains, limit }),
    listCollections(db, scope),
  ]);
  return { entries, collections };
}

/** Replace one entry's payload (scope-checked), recorded as a trace. */
export async function updateEntry(
  input: {
    specialist: Specialist;
    chatId: string;
    id: string;
    payload: Record<string, unknown>;
  },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SpecialistEntry> {
  return withTrace(
    { feature: FEATURE.id, action: "entry-update", trigger, inputSummary: `entry ${input.id}` },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "update entry",
        data: { specialistId: input.specialist.id, chatId: input.chatId, id: input.id, payload: input.payload },
      });
      assertPayloadWithinCap(input.payload);
      const scope = scopeFor(input.specialist, input.chatId);
      const record = await updateEntryInScope(db, scope, input.id, input.payload);
      if (!record) throw ApiError.notFound("No such entry in this specialist's data");
      await trace.event({ type: "db", message: "entry updated" });
      await trace.succeed({
        outputSummary: `entry ${record.id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [input.specialist.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/** Delete one entry (scope-checked), recorded as a trace. */
export async function deleteEntry(
  input: { specialist: Specialist; chatId: string; id: string },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "entry-delete", trigger, inputSummary: `entry ${input.id}` },
    async (trace) => {
      const scope = scopeFor(input.specialist, input.chatId);
      const existing = await getEntryInScope(db, scope, input.id);
      if (!existing) throw ApiError.notFound("No such entry in this specialist's data");
      await trace.event({
        type: "input",
        message: "delete entry",
        data: { specialistId: input.specialist.id, chatId: input.chatId, id: input.id, payload: existing.payload },
      });
      await deleteEntryInScope(db, scope, input.id);
      await trace.event({ type: "db", message: "entry deleted" });
      await trace.succeed({
        outputSummary: `deleted ${input.id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [input.specialist.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

/** Dashboard entries browser: latest entries with optional filters. Untraced read. */
export async function getEntriesBrowserView(
  query: ListEntriesQuery,
  db: DrizzleDb = getDb(),
): Promise<{ entries: SpecialistEntry[] }> {
  const entries = await browseEntries(db, { ...query, limit: 200 });
  return { entries };
}

export type { SpecialistEntryRecord };
