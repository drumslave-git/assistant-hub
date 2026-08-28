import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as storeSchema from "../../../store/schema";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { listTraces } from "@/server/trace";
import type { StoreDb } from "@/server/store/db";
import { getToolConnectionBySlug } from "./repository";
import { getToolConnections } from "./service";
import { resolveConnectionToolset } from "./toolset";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * The source apps' own MCP servers as managed connections: registered from
 * configuration, their snapshot following the code rather than an operator's
 * apply, and — the part that actually matters on a restart — a source that
 * did not answer keeping the tools it last offered.
 */

const { config } = vi.hoisted(() => ({
  config: { url: null as string | null },
}));

vi.mock("@/server/source/internal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/source/internal-client")>();
  return {
    ...actual,
    sourceApiConfig: (source: string) =>
      source === "tg" && config.url ? { baseUrl: config.url, token: "secret-token" } : null,
  };
});

const { reconcileManagedConnections } = await import("./managed");

describe("managed source connections", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;
  let remote: FakeMcpServer;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tool_managed_store");
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
