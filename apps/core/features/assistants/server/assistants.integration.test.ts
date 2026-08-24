import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as storeSchema from "../../../store/schema";
import { listTraces } from "@/server/trace";
import { getTraceDetail } from "@/server/trace/service";
import type { StoreDb } from "@/server/store/db";
import {
  createAssistant,
  editAssistant,
  getAssistantPersona,
  getAssistants,
  removeAssistant,
} from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Assistants CRUD over the v2 core store: uniqueness, limits, traces, and
 * the delete path's loud no-bus warning (the `assistant.deleted` publish
 * itself rides the shared publisher, exercised in the tg runtime suite).
 */

describe("assistants service", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("assistants_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE assistants RESTART IDENTITY CASCADE`);
  });

  const trigger = { kind: "dashboard" } as const;

  it("creates, lists, edits, and reads a persona", async () => {
    const created = await createAssistant({ name: "Sarcastic Bot", persona: "Be dry." }, trigger, db);
    expect(created).toMatchObject({ name: "Sarcastic Bot", persona: "Be dry." });

    const listed = await getAssistants(db);
    expect(listed.map((a) => a.name)).toEqual(["Sarcastic Bot"]);

    const edited = await editAssistant(created.id, { persona: "Be kind." }, trigger, db);
    expect(edited.persona).toBe("Be kind.");
    // The identity line is structural: a third-person persona still knows
    // its own name (user decision, 2026-08-24).
    expect(await getAssistantPersona(created.id, db)).toBe(
      "You are Sarcastic Bot.\n\nBe kind.",
    );
  });

  it("asserts the identity even with an empty persona; unknown ids stay null", async () => {
    const created = await createAssistant({ name: "Plain", persona: "  " }, trigger, db);
    expect(await getAssistantPersona(created.id, db)).toBe("You are Plain.");
    expect(await getAssistantPersona("nope", db)).toBeNull();
  });

  it("refuses a duplicate name, case-insensitively", async () => {
    await createAssistant({ name: "Echo", persona: "" }, trigger, db);
    await expect(createAssistant({ name: "echo", persona: "" }, trigger, db)).rejects.toMatchObject(
      { status: 409 },
    );
    const other = await createAssistant({ name: "Other", persona: "" }, trigger, db);
    await expect(editAssistant(other.id, { name: "ECHO" }, trigger, db)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("deletes an assistant and records the source-notification outcome", async () => {
    const created = await createAssistant({ name: "Doomed", persona: "" }, trigger, db);
    await removeAssistant(created.id, trigger, db);
    expect(await getAssistants(db)).toEqual([]);

    // The publish is env-gated: with a reachable bus the trace records the
    // published event; without one it must warn LOUDLY that sources were
    // not told. Either way the outcome is on the record — never silent.
    const { traces } = await listTraces({ feature: "assistants" });
    const header = traces.find((t) => t.action === "delete");
    expect(header?.status).toBe("success");
    // Headers carry no events — the timeline comes from the detail read.
    const del = await getTraceDetail(header!.id);
    const published = del?.events.some((e) => /assistant\.deleted published/.test(e.message));
    const warned = del?.events.some(
      (e) => e.level === "warn" && /bus not configured/i.test(e.message),
    );
    expect(published || warned).toBe(true);

    await expect(removeAssistant(created.id, trigger, db)).rejects.toMatchObject({ status: 404 });
  });

  it("records every mutation as a trace with the assistant related", async () => {
    const created = await createAssistant({ name: "Traced", persona: "" }, trigger, db);
    const { traces } = await listTraces({ feature: "assistants" });
    const create = traces.find((t) => t.action === "create");
    expect(create?.relatedIds?.assistants).toEqual([created.id]);
  });
});
