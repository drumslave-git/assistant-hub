import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertBackend } from "@/features/backends/server/repository";
import { updateSettings } from "@/features/settings/server/service";
import { getHealth, getSystemStatus } from "@/server/status";
import { startTestDb, type TestDb } from "@/test/db";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

describe("getHealth", () => {
  it("is ready when the database responds, and reflects config presence", async () => {
    const empty = await getHealth(ctx.db);
    expect(empty.ready).toBe(true);
    expect(empty.database.ok).toBe(true);
    expect(empty.configuration.configured).toBe(false);

    const backendId = randomUUID();
    await insertBackend(ctx.db, backendId, {
      name: "Main",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
      type: "openai-compatible",
    });
    await updateSettings({ chatBackendId: backendId, model: "smollm2" }, { kind: "test" }, ctx.db);

    const configured = await getHealth(ctx.db);
    expect(configured.ready).toBe(true);
    expect(configured.configuration.configured).toBe(true);
  });
});

describe("getSystemStatus", () => {
  it("reports DB connected and LLM unconfigured before setup (no network probe)", async () => {
    const status = await getSystemStatus(ctx.db);
    expect(status.db.connected).toBe(true);
    expect(status.llm.state).toBe("unconfigured");
    expect(status.model.selected).toBe(false);
  });

  it("reports every optional endpoint as off before setup (no network probe)", async () => {
    const status = await getSystemStatus(ctx.db);
    expect(status.endpoints.map((endpoint) => endpoint.id)).toEqual([
      "embeddings",
      "images",
      "speech",
      "audio",
      "vision",
      "browser",
    ]);
    for (const endpoint of status.endpoints) {
      expect(endpoint.state).toBe("off");
      expect(endpoint.detail).not.toBe("");
    }
  });
});
