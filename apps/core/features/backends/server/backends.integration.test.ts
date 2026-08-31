import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { updateSettings } from "@/features/settings/server/service";
import { listModels } from "@/server/llm/client";
import { getTraceDetail, listTraces } from "@/server/trace";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { getBackendById } from "./repository";
import {
  createBackend,
  editBackend,
  getBackends,
  listBackendModels,
  removeBackend,
  rolesUsingBackend,
  testBackend,
} from "./service";

// Connection tests and stale-model verification list models over the network;
// a test must never make that call.
vi.mock("@/server/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/client")>();
  return { ...actual, listModels: vi.fn() };
});

const listModelsMock = vi.mocked(listModels);

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  listModelsMock.mockReset();
  listModelsMock.mockRejectedValue(new Error("model listing unavailable in this test"));
});

const trigger = { kind: "dashboard" } as const;

describe("backends CRUD", () => {
  it("creates a backend, masking the key and recording a trace", async () => {
    const created = await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", apiKey: "sk-secret", type: "ollama" },
      trigger,
      ctx.db,
    );
    expect(created.name).toBe("Main");
    expect(created.type).toBe("ollama");
    expect(created.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-secret");
    // The raw key is stored for provider calls, just never surfaced.
    expect((await getBackendById(ctx.db, created.id))?.apiKey).toBe("sk-secret");

    const traces = await listTraces({ feature: "backends" });
    expect(traces.traces[0]?.action).toBe("create");
    const detail = await getTraceDetail(traces.traces[0].id);
    expect(JSON.stringify(detail)).not.toContain("sk-secret");
  });

  it("rejects a duplicate name case-insensitively", async () => {
    await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await expect(
      createBackend(
        { name: "main", baseUrl: "https://other.example/v1", type: "openai-compatible" },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("edits fields write-only for the key (empty clears, omitted keeps)", async () => {
    const created = await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", apiKey: "sk-old", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    const { backend: renamed } = await editBackend(
      created.id,
      { name: "Primary" },
      trigger,
      ctx.db,
    );
    expect(renamed.name).toBe("Primary");
    expect((await getBackendById(ctx.db, created.id))?.apiKey).toBe("sk-old");

    await editBackend(created.id, { apiKey: null }, trigger, ctx.db);
    expect((await getBackendById(ctx.db, created.id))?.apiKey).toBeNull();
  });

  it("deletes an unused backend and lists the survivors", async () => {
    const a = await createBackend(
      { name: "A", baseUrl: "https://a.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    const b = await createBackend(
      { name: "B", baseUrl: "https://b.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await removeBackend(a.id, trigger, ctx.db);
    expect((await getBackends(ctx.db)).map((x) => x.id)).toEqual([b.id]);
  });

  it("refuses to delete a backend a settings role points at, naming the roles", async () => {
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await updateSettings(
      { chatBackendId: backend.id, model: "gemma", visionBackendId: backend.id },
      trigger,
      ctx.db,
    );
    expect(await rolesUsingBackend(backend.id, ctx.db)).toEqual(["chat", "vision"]);
    await expect(removeBackend(backend.id, trigger, ctx.db)).rejects.toThrow(/chat, vision/);
    // Still there.
    expect(await getBackendById(ctx.db, backend.id)).not.toBeNull();
  });
});

describe("testBackend / model listing", () => {
  it("tests a stored backend with its stored key and returns the model preview", async () => {
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", apiKey: "sk-stored", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    listModelsMock.mockResolvedValue(["m1", "m2"]);
    const result = await testBackend({ backendId: backend.id }, trigger, ctx.db);
    expect(result.models).toEqual(["m1", "m2"]);
    expect(listModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://llm.example/v1", apiKey: "sk-stored" }),
    );
  });

  it("tests an ad-hoc URL (create form) without touching the catalog", async () => {
    listModelsMock.mockResolvedValue(["m1"]);
    const result = await testBackend(
      { baseUrl: "https://new.example/v1", apiKey: "sk-typed" },
      trigger,
      ctx.db,
    );
    expect(result.models).toEqual(["m1"]);
    expect(await getBackends(ctx.db)).toEqual([]);
  });

  it("listBackendModels rejects an unknown id and surfaces listing failures", async () => {
    await expect(listBackendModels("nope", ctx.db)).rejects.toThrow(/unknown backend/i);
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://dead.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    await expect(listBackendModels(backend.id, ctx.db)).rejects.toThrow(/connection refused/);
  });
});

describe("stale model clearing on backend edit", () => {
  it("repointing a backend's URL clears role models the new endpoint does not serve", async () => {
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://old.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await updateSettings(
      {
        chatBackendId: backend.id,
        model: "chat-model",
        embeddingModel: "bge-m3",
        audioModel: "whisper-1",
      },
      trigger,
      ctx.db,
    );
    listModelsMock.mockResolvedValue(["bge-m3"]);

    const { clearedModels } = await editBackend(
      backend.id,
      { baseUrl: "https://new.example/v1" },
      trigger,
      ctx.db,
    );
    expect(clearedModels).toEqual(["chat model"]);

    const settingsAfter = await updateSettings({ speechVoice: "sky" }, trigger, ctx.db);
    expect(settingsAfter.model).toBeNull();
    expect(settingsAfter.embeddingModel).toBe("bge-m3");
    // Audio is exempt — absence from a listing proves nothing for STT servers.
    expect(settingsAfter.audioModel).toBe("whisper-1");
  });

  it("a rename does not verify or clear anything", async () => {
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://llm.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await updateSettings({ chatBackendId: backend.id, model: "chat-model" }, trigger, ctx.db);
    listModelsMock.mockClear();

    const { clearedModels } = await editBackend(backend.id, { name: "Renamed" }, trigger, ctx.db);
    expect(clearedModels).toEqual([]);
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("a failed listing on the new URL clears nothing", async () => {
    const backend = await createBackend(
      { name: "Main", baseUrl: "https://old.example/v1", type: "openai-compatible" },
      trigger,
      ctx.db,
    );
    await updateSettings({ chatBackendId: backend.id, model: "chat-model" }, trigger, ctx.db);
    listModelsMock.mockRejectedValue(new Error("connection refused"));

    const { clearedModels } = await editBackend(
      backend.id,
      { baseUrl: "https://dead.example/v1" },
      trigger,
      ctx.db,
    );
    expect(clearedModels).toEqual([]);
    const after = await updateSettings({ speechVoice: "sky" }, trigger, ctx.db);
    expect(after.model).toBe("chat-model");
  });
});
