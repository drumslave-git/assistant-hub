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
import { createAssistant } from "@/features/assistants/server/service";
import { listTraces } from "@/server/trace";
import { getTraceDetail } from "@/server/trace/service";
import type { StoreDb } from "@/server/store/db";
import {
  getToolConnectionBySlug,
  replaceSnapshot,
  toolRegistryRevision,
} from "./repository";
import {
  createToolConnection,
  editToolConnection,
  getToolConnections,
  removeToolConnection,
} from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Tool-connections CRUD over the v2 core store: slug uniqueness, the
 * transports v2 executes, secret masking (values never leave the server, not
 * even into a trace body), the assistant selection, and the revision token
 * the registry's staleness check hangs on.
 */

describe("tool connections service", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tool_connections_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE tool_connections, assistants RESTART IDENTITY CASCADE`);
  });

  const trigger = { kind: "dashboard" } as const;

  const input = {
    slug: "weather",
    name: "Weather service",
    transport: "http" as const,
    endpointUrl: "https://tools.example.test/mcp",
    authHeaders: { Authorization: "Bearer secret-token" },
    enabled: true,
    appScope: null,
    allAssistants: true,
    assistantIds: [],
  };

  it("creates a connection and withholds header values from clients", async () => {
    const created = await createToolConnection(input, trigger, db);

    expect(created).toMatchObject({
      slug: "weather",
      name: "Weather service",
      endpointUrl: "https://tools.example.test/mcp",
      enabled: true,
      appScope: null,
      allAssistants: true,
      managed: false,
      tools: [],
    });
    expect(created.authHeaderNames).toEqual(["Authorization"]);
    expect(JSON.stringify(created)).not.toContain("secret-token");

    // The value IS stored — masking is a boundary rule, not data loss.
    const stored = await getToolConnectionBySlug(db, "weather");
    expect(stored?.authHeaders).toEqual({ Authorization: "Bearer secret-token" });
  });

  it("keeps header values out of the trace body too", async () => {
    await createToolConnection(input, trigger, db);
    const traces = await listTraces({ feature: "tool-connections" });
    const detail = await getTraceDetail(traces.traces[0].id);
    const body = JSON.stringify(detail);
    expect(body).toContain("Authorization");
    expect(body).not.toContain("secret-token");
  });

  it("refuses a duplicate slug and a transport v2 cannot execute", async () => {
    await createToolConnection(input, trigger, db);
    await expect(
      createToolConnection({ ...input, name: "Another" }, trigger, db),
    ).rejects.toThrow(/already exists/);
    await expect(
      createToolConnection(
        { ...input, slug: "shell", transport: "stdio" },
        trigger,
        db,
      ),
    ).rejects.toThrow(/Only http connections/);
  });

  it("scopes a connection to one app and an explicit assistant selection", async () => {
    const assistant = await createAssistant({ name: "Anna", persona: "" }, trigger, db);
    const created = await createToolConnection(
      { ...input, appScope: "tg", allAssistants: false, assistantIds: [assistant.id] },
      trigger,
      db,
    );
    expect(created).toMatchObject({
      appScope: "tg",
      allAssistants: false,
      assistantIds: [assistant.id],
    });

    // Selecting nobody is an explicit empty selection, not a fallback to all.
    const cleared = await editToolConnection(created.id, { assistantIds: [] }, trigger, db);
    expect(cleared.assistantIds).toEqual([]);
    expect(cleared.allAssistants).toBe(false);

    await expect(
      editToolConnection(created.id, { assistantIds: ["nobody"] }, trigger, db),
    ).rejects.toThrow(/Unknown assistant/);
  });

  it("replaces the whole header set on update and deletes with its snapshot", async () => {
    const created = await createToolConnection(input, trigger, db);
    await replaceSnapshot(db, created.id, [
      { name: "forecast", description: "Tomorrow", inputSchema: { type: "object" } },
    ]);

    const updated = await editToolConnection(
      created.id,
      { authHeaders: { "X-Api-Key": "other" } },
      trigger,
      db,
    );
    expect(updated.authHeaderNames).toEqual(["X-Api-Key"]);
    expect(updated.tools).toHaveLength(1);

    await removeToolConnection(created.id, trigger, db);
    expect(await getToolConnections(db)).toEqual([]);
    const { rows } = await pool.query(`select count(*)::int as n from tool_connection_tools`);
    expect(rows[0].n).toBe(0);
  });

  it("moves the registry revision on every change that alters the toolset", async () => {
    const before = await toolRegistryRevision(db);
    const created = await createToolConnection(input, trigger, db);
    const afterCreate = await toolRegistryRevision(db);
    expect(afterCreate).not.toBe(before);

    await replaceSnapshot(db, created.id, [
      { name: "forecast", description: "Tomorrow", inputSchema: { type: "object" } },
    ]);
    const afterApply = await toolRegistryRevision(db);
    expect(afterApply).not.toBe(afterCreate);

    await removeToolConnection(created.id, trigger, db);
    expect(await toolRegistryRevision(db)).not.toBe(afterApply);
  });
});
