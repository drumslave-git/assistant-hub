import "server-only";

import { randomUUID } from "node:crypto";

import {
  BUS_EVENTS_CHANNEL,
  assistantDeletedEventSchema,
  type AssistantDeletedEvent,
} from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getBusPublisher } from "@/server/bus/publisher";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import {
  countAssistants,
  deleteAssistant,
  getAssistantById,
  insertAssistant,
  isNameTaken,
  listAssistants,
  updateAssistant,
  type AssistantRecord,
} from "./repository";
import {
  MAX_ASSISTANTS,
  type Assistant,
  type CreateAssistant,
  type UpdateAssistant,
} from "./schema";

/**
 * Assistants domain service — the boundary Route Handlers, Server
 * Components, and the turn pipeline call. Owns validation (case-insensitive
 * name uniqueness, the max-count guard), trace recording for every mutation,
 * live-refresh publishing, and the `assistant.deleted` lifecycle event the
 * source apps react to (PLAN "Entity lifecycle across apps"). Reads are
 * cheap and untraced.
 */

const FEATURE = FEATURES["assistants"];

/** A stored record is already client-safe. */
function toClient(record: AssistantRecord): Assistant {
  return record;
}

/** All assistants, oldest first. */
export async function getAssistants(db: StoreDb = getStoreDb()): Promise<Assistant[]> {
  return (await listAssistants(db)).map(toClient);
}

/** One assistant by id, or null. */
export async function getAssistant(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<Assistant | null> {
  const record = await getAssistantById(db, id);
  return record ? toClient(record) : null;
}

/**
 * Server-only: the persona of one assistant, or null when the id is unknown.
 * The reply pipeline resolves the persona of the assistant the event names.
 */
export async function getAssistantPersona(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  const record = await getAssistantById(db, id);
  if (!record) return null;
  return record.persona.trim() ? record.persona : null;
}

/** Create an assistant, recorded as a trace. */
export async function createAssistant(
  input: CreateAssistant,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<Assistant> {
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.name },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "create assistant",
        data: { name: input.name, persona: input.persona },
      });
      if ((await countAssistants(db)) >= MAX_ASSISTANTS) {
        throw ApiError.conflict(`At most ${MAX_ASSISTANTS} assistants are allowed`);
      }
      if (await isNameTaken(db, input.name)) {
        throw ApiError.conflict(`An assistant named "${input.name}" already exists`);
      }
      const record = await insertAssistant(db, randomUUID(), {
        name: input.name,
        persona: input.persona,
      });
      await trace.event({ type: "db", message: "assistant created" });
      await trace.succeed({
        outputSummary: record.name,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
      return toClient(record);
    },
  );
}

/** Apply a validated update to an assistant, recorded as a trace. */
export async function editAssistant(
  id: string,
  input: UpdateAssistant,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<Assistant> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `assistant ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update assistant", data: { id, ...input } });
      const existing = await getAssistantById(db, id);
      if (!existing) throw ApiError.notFound("Unknown assistant");
      if (input.name !== undefined && (await isNameTaken(db, input.name, id))) {
        throw ApiError.conflict(`An assistant named "${input.name}" already exists`);
      }
      const record = await updateAssistant(db, id, input);
      if (!record) throw ApiError.notFound("Unknown assistant");
      await trace.event({ type: "db", message: "assistant updated" });
      await trace.succeed({
        outputSummary: record.name,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
      return toClient(record);
    },
  );
}

/** The `assistant.deleted` lifecycle event for one id. */
function deletedEvent(assistantId: string): AssistantDeletedEvent {
  return assistantDeletedEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: assistantId,
    type: "assistant.deleted",
    assistantId,
  });
}

/**
 * Delete an assistant, recorded as a trace. Its tasks cascade in the store;
 * everything a SOURCE app keys on the id (the tg connection and its poller)
 * is dropped by the app reacting to the `assistant.deleted` bus event — so
 * with no bus configured the skipped notification is a loud trace warning,
 * never a silent divergence.
 */
export async function removeAssistant(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `assistant ${id}` },
    async (trace) => {
      const deleted = await deleteAssistant(db, id);
      if (!deleted) throw ApiError.notFound("Unknown assistant");
      await trace.event({ type: "db", message: "assistant deleted (tasks cascaded)" });
      const publisher = getBusPublisher();
      if (publisher) {
        await publisher.publish(BUS_EVENTS_CHANNEL, deletedEvent(id));
        await trace.event({
          type: "external_call",
          message: "assistant.deleted published — sources drop their connections",
        });
      } else {
        await trace.event({
          type: "step",
          level: "warn",
          message:
            "bus not configured (REDIS_URL) — source apps were NOT told; any connection for this assistant keeps polling",
        });
      }
      await trace.succeed({
        outputSummary: `deleted ${id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
      publishEvent(FEATURE.realtimeTopic!);
    },
  );
}
