import { fileURLToPath } from "node:url";

import { TURN_META_KEY } from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as storeSchema from "../../../store/schema";
import { createAssistant } from "@/features/assistants/server/service";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { runWithToolContext } from "@/server/mcp/context";
import { listTraces } from "@/server/trace";
import { getTraceDetail } from "@/server/trace/service";
import type { StoreDb } from "@/server/store/db";
import { applyToolConnection, discoverToolConnection } from "./discovery";
import { getToolConnectionBySlug, replaceSnapshot } from "./repository";
import type { CreateToolConnection } from "./schema";
import {
  createToolConnection,
  editToolConnection,
  getToolConnections,
  removeToolConnection,
} from "./service";
import { resolveConnectionToolset } from "./toolset";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * The whole tool-connections feature against a real Postgres and a real MCP
 * server: CRUD, discovery and apply, scope resolution and the remote call
 * path, and the managed connections the source apps get.
 *
 * One file because it is one container. Every integration suite here starts
 * its own Postgres, and four containers for one feature is four container
 * lifecycles of setup, teardown and flake for tests that all want the same
 * two things.
 */

/** Where the managed reconciler believes the tg app lives, per test. */
const { config } = vi.hoisted(() => ({ config: { url: null as string | null } }));

process.env.INTERNAL_API_TOKEN = "secret-token";
vi.mock("@/server/transports/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/transports/service")>();
  return {
    ...actual,
    getTransport: async (source: string) =>
      source === "tg" && config.url
        ? { id: "tg", name: "Telegram", baseUrl: config.url, mcpPath: "/mcp", enabled: true }
        : null,
  };
});

const { reconcileManagedConnections } = await import("./managed");

/** The one container, shared by every suite in this file. */
let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("tool_connections");
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

describe("tool connections service", () => {
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
});

describe("tool connection discovery", () => {
  let remote: FakeMcpServer;

  beforeAll(async () => {
    remote = await startFakeMcpServer();
  });

  afterAll(async () => {
    await remote?.close();
  });

  beforeEach(async () => {
    remote.failWith(null);
    remote.setTools([
      { name: "forecast", description: "Tomorrow's weather", inputShape: { city: z.string() } },
      { name: "history", description: "Yesterday's weather" },
    ]);
  });

  const trigger = { kind: "dashboard" } as const;

  async function connection() {
    return createToolConnection(
      {
        slug: "weather",
        name: "Weather service",
        transport: "http",
        endpointUrl: remote.url,
        authHeaders: { Authorization: "Bearer secret-token" },
        enabled: true,
        appScope: null,
        allAssistants: true,
        assistantIds: [],
      },
      trigger,
      db,
    );
  }

  it("discovers without offering, then applies", async () => {
    const created = await connection();

    const report = await discoverToolConnection(created.id, trigger, db);
    expect(report.ok).toBe(true);
    expect(report.diff).toMatchObject({ added: ["forecast", "history"], removed: [] });
    // Discovery is a report: nothing is offered yet.
    expect(report.connection.tools).toEqual([]);
    expect(report.connection.discoveredTools).toHaveLength(2);

    const applied = await applyToolConnection(created.id, trigger, db);
    expect(applied.tools.map((tool) => tool.name)).toEqual(["forecast", "history"]);
    expect(applied.drift).toMatchObject({ added: [], changed: [], removed: [] });
    expect(applied.tools[0].inputSchema).toMatchObject({ type: "object" });
  });

  it("sends the operator's auth headers to the server", async () => {
    const created = await connection();
    await discoverToolConnection(created.id, trigger, db);
    expect(remote.lastHeaders().authorization).toBe("Bearer secret-token");
  });

  it("reports drift without changing what the model is offered", async () => {
    const created = await connection();
    await discoverToolConnection(created.id, trigger, db);
    await applyToolConnection(created.id, trigger, db);

    remote.setTools([
      { name: "forecast", description: "Tomorrow, now with wind", inputShape: { city: z.string() } },
      { name: "radar", description: "Live radar" },
    ]);
    const report = await discoverToolConnection(created.id, trigger, db);

    expect(report.diff).toEqual({
      added: ["radar"],
      changed: ["forecast"],
      removed: ["history"],
      unchanged: [],
    });
    // Still the applied set — the drift is a question, not an edit.
    expect(report.connection.tools.map((tool) => tool.name)).toEqual(["forecast", "history"]);
    expect(report.connection.tools[0].description).toBe("Tomorrow's weather");

    const applied = await applyToolConnection(created.id, trigger, db);
    expect(applied.tools.map((tool) => tool.name)).toEqual(["forecast", "radar"]);
    expect(applied.tools.find((tool) => tool.name === "forecast")?.description).toBe(
      "Tomorrow, now with wind",
    );
  });

  it("records an unreachable server without losing the applied toolset", async () => {
    const created = await connection();
    await discoverToolConnection(created.id, trigger, db);
    await applyToolConnection(created.id, trigger, db);

    remote.failWith(503);
    const report = await discoverToolConnection(created.id, trigger, db);

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/streamable-http/);
    expect(report.connection.lastError).toBe(report.error);
    expect(report.connection.tools).toHaveLength(2);

    const traces = await listTraces({ feature: "tool-connections" });
    const discovery = traces.traces.find((trace) => trace.action === "discover");
    expect(discovery?.status).toBe("error");
  });

  it("refuses to apply a connection nobody has discovered", async () => {
    const created = await connection();
    await expect(applyToolConnection(created.id, trigger, db)).rejects.toThrow(
      /Discover this connection/,
    );
  });
});

describe("connection toolset", () => {
  let remote: FakeMcpServer;

  beforeAll(async () => {
    remote = await startFakeMcpServer();
  });

  afterAll(async () => {
    await remote?.close();
  });

  beforeEach(async () => {
    remote.failWith(null);
    remote.setTools([
      {
        name: "forecast",
        description: "Tomorrow's weather",
        inputShape: { city: z.string() },
        handler: (args, meta) =>
          `forecast for ${args.city} :: ${JSON.stringify(meta?.[TURN_META_KEY] ?? null)}`,
      },
    ]);
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

describe("managed source connections", () => {
  let remote: FakeMcpServer;

  beforeAll(async () => {
    remote = await startFakeMcpServer();
  });

  afterAll(async () => {
    await remote?.close();
  });

  beforeEach(async () => {
    remote.failWith(null);
    remote.setTools([{ name: "set_message_reaction", description: "React to a message" }]);
    // The fake serves at `<base>/mcp`, which is where the reconciler points.
    config.url = remote.url.replace(/\/mcp$/, "");
  });

  afterEach(() => {
    config.url = null;
  });

  it("registers a deployed source and applies its toolset without an operator", async () => {
    await reconcileManagedConnections({ kind: "system" }, db);

    const [connection] = await getToolConnections(db);
    expect(connection).toMatchObject({
      slug: "tg",
      appScope: "tg",
      managed: true,
      enabled: true,
      allAssistants: true,
    });
    expect(connection.tools.map((tool) => tool.name)).toEqual(["set_message_reaction"]);
    // Offered on that source's turns, and only those.
    expect(
      (await resolveConnectionToolset({ source: "tg" }, db)).tools.map((t) => t.function.name),
    ).toEqual(["tg__set_message_reaction"]);
    expect((await resolveConnectionToolset({ source: "chat" }, db)).tools).toEqual([]);
  });

  it("sends the internal token, so the app's guard lets it in", async () => {
    await reconcileManagedConnections({ kind: "system" }, db);
    expect(remote.lastHeaders()["x-internal-token"]).toBe("secret-token");
  });

  it("follows the code when the release changes what the app offers", async () => {
    await reconcileManagedConnections({ kind: "system" }, db);
    remote.setTools([
      { name: "set_message_reaction", description: "React to a message" },
      { name: "send_message", description: "Say something in this chat" },
    ]);
    await reconcileManagedConnections({ kind: "system" }, db);

    const connection = await getToolConnectionBySlug(db, "tg");
    expect(connection!.tools.map((tool) => tool.name)).toEqual([
      "send_message",
      "set_message_reaction",
    ]);
  });

  it("keeps the last toolset when the app is still starting", async () => {
    await reconcileManagedConnections({ kind: "system" }, db);
    remote.failWith(503);
    await reconcileManagedConnections({ kind: "system" }, db);

    const connection = await getToolConnectionBySlug(db, "tg");
    expect(connection!.tools.map((tool) => tool.name)).toEqual(["set_message_reaction"]);
    expect(connection!.lastError).toMatch(/streamable-http/);

    const traces = await listTraces({ feature: "tool-connections" });
    const trace = traces.traces.find((t) => t.action === "reconcile-managed");
    expect(trace?.outputSummary).toContain("unreachable");
  });

  it("disables a source this deployment does not run", async () => {
    await reconcileManagedConnections({ kind: "system" }, db);
    config.url = null;
    await reconcileManagedConnections({ kind: "system" }, db);

    const connection = await getToolConnectionBySlug(db, "tg");
    expect(connection!.enabled).toBe(false);
    // Its snapshot survives — what is gone is the app, not the operator's setup.
    expect(connection!.tools).toHaveLength(1);
    expect((await resolveConnectionToolset({ source: "tg" }, db)).tools).toEqual([]);
  });
});

