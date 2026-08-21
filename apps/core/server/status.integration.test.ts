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
      "classifier",
      "background",
    ]);
    // Nothing configured at all: even the chat-fallback roles have nothing to
    // fall back to, so "off" is the honest answer for every one of them.
    for (const endpoint of status.endpoints) {
      expect(endpoint.state).toBe("off");
      expect(endpoint.detail).not.toBe("");
    }
  });

  it("reports chat-fallback roles as inherited — not off — once a chat model is set", async () => {
    const backendId = randomUUID();
    await insertBackend(ctx.db, backendId, {
      name: "Main",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
      type: "openai-compatible",
    });
    await updateSettings({ chatBackendId: backendId, model: "smollm2" }, { kind: "test" }, ctx.db);

    const status = await getSystemStatus(ctx.db);
    const byId = new Map(status.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    // Voice transcription, media description and browsing all run on the chat
    // model when they have no model of their own — the feature is on.
    for (const id of ["audio", "vision", "browser", "classifier", "background"] as const) {
      expect(byId.get(id)?.state).toBe("inherited");
      expect(byId.get(id)?.detail).toMatch(/chat model/i);
    }
    // The genuinely optional ones stay off: nothing runs them.
    for (const id of ["embeddings", "images", "speech"] as const) {
      expect(byId.get(id)?.state).toBe("off");
    }
  });
});
