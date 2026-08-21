import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getSettingsRecord, upsertSettings } from "@/features/settings/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { withTrace } from "@/server/trace";
import {
  countPersonalities,
  deletePersonality,
  getPersonalityById,
  insertPersonality,
  isNameTaken,
  listPersonalities,
  updatePersonality,
  type PersonalityRecord,
} from "./repository";
import {
  MAX_PERSONALITIES,
  type CreatePersonality,
  type Personality,
  type UpdatePersonality,
} from "./schema";

/**
 * Personalities domain service — the boundary Route Handlers, Server Components,
 * and the bot runtime call. Owns validation (case-insensitive name uniqueness,
 * the max-count guard), active-selection state (stored on the settings row), and
 * trace recording for every mutation. Reads are cheap and untraced.
 */

const FEATURE = FEATURES["personalities"];

/** A stored record is already client-safe. */
function toClient(record: PersonalityRecord): Personality {
  return record;
}

/** The personalities list plus which one is active. */
export interface PersonalitiesView {
  personalities: Personality[];
  activeId: string | null;
}

/** All personalities (oldest first) and the active selection. */
export async function getPersonalitiesView(db: DrizzleDb = getDb()): Promise<PersonalitiesView> {
  const [records, settings] = await Promise.all([listPersonalities(db), getSettingsRecord(db)]);
  return {
    personalities: records.map(toClient),
    activeId: settings?.activePersonalityId ?? null,
  };
}

/** One personality by id, or null. */
export async function getPersonality(
  id: string,
  db: DrizzleDb = getDb(),
): Promise<Personality | null> {
  const record = await getPersonalityById(db, id);
  return record ? toClient(record) : null;
}

/** Create a personality, recorded as a trace. */
export async function createPersonality(
  input: CreatePersonality,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Personality> {
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.name },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "create personality",
        data: { name: input.name, prompt: input.prompt },
      });
      if ((await countPersonalities(db)) >= MAX_PERSONALITIES) {
        throw ApiError.conflict(`At most ${MAX_PERSONALITIES} personalities are allowed`);
      }
      if (await isNameTaken(db, input.name)) {
        throw ApiError.conflict(`A personality named "${input.name}" already exists`);
      }
      const record = await insertPersonality(db, randomUUID(), {
        name: input.name,
        prompt: input.prompt,
      });
      await trace.event({ type: "db", message: "personality created" });
      await trace.succeed({ outputSummary: record.name, relatedIds: { [FEATURE.relatedIdsKey]: [record.id] } });
      return toClient(record);
    },
  );
}

/** Apply a validated update to a personality, recorded as a trace. */
export async function editPersonality(
  id: string,
  input: UpdatePersonality,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Personality> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `personality ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update personality", data: { id, ...input } });
      const existing = await getPersonalityById(db, id);
      if (!existing) throw ApiError.notFound("Unknown personality");
      if (input.name !== undefined && (await isNameTaken(db, input.name, id))) {
        throw ApiError.conflict(`A personality named "${input.name}" already exists`);
      }
      const record = await updatePersonality(db, id, input);
      if (!record) throw ApiError.notFound("Unknown personality");
      await trace.event({ type: "db", message: "personality updated" });
      await trace.succeed({ outputSummary: record.name, relatedIds: { [FEATURE.relatedIdsKey]: [record.id] } });
      return toClient(record);
    },
  );
}

/**
 * Delete a personality, recorded as a trace. If it was the active one, the
 * settings FK (`on delete set null`) clears the active selection automatically.
 */
export async function removePersonality(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `personality ${id}` },
    async (trace) => {
      const deleted = await deletePersonality(db, id);
      if (!deleted) throw ApiError.notFound("Unknown personality");
      await trace.event({ type: "db", message: "personality deleted" });
      await trace.succeed({ outputSummary: `deleted ${id}`, relatedIds: { [FEATURE.relatedIdsKey]: [id] } });
    },
  );
}

/**
 * Set (or clear, with null) the active personality, recorded as a trace. A
 * non-null id must reference an existing personality.
 */
export async function setActivePersonality(
  personalityId: string | null,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<PersonalitiesView> {
  return withTrace(
    { feature: FEATURE.id, action: "set-active", trigger, inputSummary: personalityId ?? "(none)" },
    async (trace) => {
      await trace.event({ type: "input", message: "set active personality", data: { personalityId } });
      if (personalityId) {
        const exists = await getPersonalityById(db, personalityId);
        if (!exists) throw ApiError.badRequest("Selected personality does not exist");
      }
      await upsertSettings(db, { activePersonalityId: personalityId });
      await trace.event({ type: "db", message: "active personality set" });
      await trace.succeed({
        outputSummary: personalityId ? `active ${personalityId}` : "cleared",
        relatedIds: personalityId ? { [FEATURE.relatedIdsKey]: [personalityId] } : undefined,
      });
      return getPersonalitiesView(db);
    },
  );
}

/**
 * Server-only: the active personality's prompt, or null when none is selected
 * (or the selection was deleted). Composed into the system prompt on every reply
 * by the bot-messaging service.
 */
export async function getActivePersonalityPrompt(db: DrizzleDb = getDb()): Promise<string | null> {
  const settings = await getSettingsRecord(db);
  const id = settings?.activePersonalityId;
  if (!id) return null;
  const record = await getPersonalityById(db, id);
  return record?.prompt ?? null;
}
