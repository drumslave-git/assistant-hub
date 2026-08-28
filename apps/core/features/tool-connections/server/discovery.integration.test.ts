import { fileURLToPath } from "node:url";

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
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { listTraces } from "@/server/trace";
import type { StoreDb } from "@/server/store/db";
import { applyToolConnection, discoverToolConnection } from "./discovery";
import { createToolConnection } from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Discovery and apply against a real MCP server over Streamable HTTP: the
 * snapshot moves only on apply, drift is reported without touching what the
 * model is offered, auth headers actually reach the server, and an
 * unreachable server is a recorded outcome rather than lost state.
 */

describe("tool connection discovery", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;
  let remote: FakeMcpServer;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tool_discovery_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
    remote = await startFakeMcpServer();
  });

  afterAll(async () => {
    await remote?.close();
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE tool_connections, assistants RESTART IDENTITY CASCADE`);
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
