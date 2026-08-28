import { fileURLToPath } from "node:url";

import { TURN_META_KEY } from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import * as storeSchema from "../../../store/schema";
import { createAssistant } from "@/features/assistants/server/service";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { runWithToolContext } from "@/server/mcp/context";
import type { StoreDb } from "@/server/store/db";
import { applyToolConnection, discoverToolConnection } from "./discovery";
import type { CreateToolConnection } from "./schema";
import { createToolConnection } from "./service";
import { resolveConnectionToolset } from "./toolset";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Scope resolution and the remote call path: which connections a turn is
 * offered (global / per-app / per-assistant), the slug prefix that keeps two
 * connections' tools apart, and what a call carries to the server — the turn
 * binding as `_meta`, never as an argument the model could aim.
 */

describe("connection toolset", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;
  let remote: FakeMcpServer;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tool_toolset_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
    remote = await startFakeMcpServer([
      {
        name: "forecast",
        description: "Tomorrow's weather",
        inputShape: { city: z.string() },
        handler: (args, meta) =>
          `forecast for ${args.city} :: ${JSON.stringify(meta?.[TURN_META_KEY] ?? null)}`,
      },
    ]);
  });

  afterAll(async () => {
    await remote?.close();
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE tool_connections, assistants RESTART IDENTITY CASCADE`);
    remote.failWith(null);
  });

  const trigger = { kind: "dashboard" } as const;

  /** A connection whose tools are discovered and applied, ready to be offered. */
  async function ready(overrides: Partial<CreateToolConnection> = {}) {
    const created = await createToolConnection(
      {
        slug: "weather",
        name: "Weather service",
        transport: "http",
        endpointUrl: remote.url,
        authHeaders: {},
        enabled: true,
        appScope: null,
        allAssistants: true,
        assistantIds: [],
        ...overrides,
      },
      trigger,
      db,
    );
    await discoverToolConnection(created.id, trigger, db);
    await applyToolConnection(created.id, trigger, db);
    return created;
  }

  const names = async (scope: Parameters<typeof resolveConnectionToolset>[0]) =>
    (await resolveConnectionToolset(scope, db)).tools.map((tool) => tool.function.name);

  it("offers an applied global connection under its slug prefix", async () => {
    await ready();
    expect(await names({ source: "tg", assistantId: "a1" })).toEqual(["weather__forecast"]);
    expect(await names({ source: "chat", assistantId: null })).toEqual(["weather__forecast"]);
  });

  it("offers nothing before an apply, and nothing while disabled", async () => {
    const created = await createToolConnection(
      {
        slug: "weather",
        name: "Weather service",
        transport: "http",
        endpointUrl: remote.url,
        authHeaders: {},
        enabled: true,
        appScope: null,
        allAssistants: true,
        assistantIds: [],
      },
      trigger,
      db,
    );
    await discoverToolConnection(created.id, trigger, db);
    // Discovered, not applied: the model is offered nothing.
    expect(await names({ source: "tg" })).toEqual([]);

    await applyToolConnection(created.id, trigger, db);
    await pool.query(`update tool_connections set enabled = false`);
    expect(await names({ source: "tg" })).toEqual([]);
  });

  it("keeps an app-scoped connection out of another source's turn", async () => {
    await ready({ appScope: "chat" });
    expect(await names({ source: "chat" })).toEqual(["weather__forecast"]);
    expect(await names({ source: "tg" })).toEqual([]);
    // A turn whose source is unknown gets no app-scoped tools either.
    expect(await names({})).toEqual([]);
  });

  it("honours an explicit assistant selection", async () => {
    const anna = await createAssistant({ name: "Anna", persona: "" }, trigger, db);
    const igor = await createAssistant({ name: "Igor", persona: "" }, trigger, db);
    await ready({ allAssistants: false, assistantIds: [anna.id] });

    expect(await names({ source: "tg", assistantId: anna.id })).toEqual(["weather__forecast"]);
    expect(await names({ source: "tg", assistantId: igor.id })).toEqual([]);
    expect(await names({ source: "tg", assistantId: null })).toEqual([]);
  });

  it("calls the remote tool and carries the turn binding as _meta", async () => {
    await ready();
    const toolset = await resolveConnectionToolset({ source: "tg", assistantId: "a1" }, db);

    const result = await runWithToolContext(
      {
        source: "tg",
        chatId: "-100200",
        assistantId: "a1",
        userId: "42",
        correlationId: "-100200:7",
        senderIsOwner: true,
      },
      () => toolset.callTool("weather__forecast", { city: "Riga" }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("forecast for Riga");
    const meta = JSON.parse(result.text.split(" :: ")[1]);
    expect(meta).toMatchObject({
      source: "tg",
      chatId: "-100200",
      assistantId: "a1",
      userId: "42",
      correlationId: "-100200:7",
      senderIsOwner: true,
    });
    // The model chose the city and nothing else: the binding is not an argument.
    expect(toolset.tools[0].function.parameters).toMatchObject({
      properties: { city: { type: "string" } },
    });
  });

  it("turns an unreachable server and an unknown name into tool errors", async () => {
    await ready();
    const toolset = await resolveConnectionToolset({ source: "tg" }, db);

    const unknown = await toolset.callTool("weather__nope", {});
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain("Unknown tool");

    remote.failWith(500);
    const dead = await runWithToolContext({ source: "tg", chatId: "-100200" }, () =>
      toolset.callTool("weather__forecast", { city: "Riga" }),
    );
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain("could not be reached");
  });
});
