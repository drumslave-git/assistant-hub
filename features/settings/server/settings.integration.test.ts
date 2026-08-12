import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { listModels } from "@/server/llm/client";
import { getTraceDetail, listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import { getSettingsRecord, upsertSettings } from "./repository";
import { updateSettingsSchema } from "./schema";
import {
  getBotPolicy,
  getDailyJobsRunTime,
  getEmbeddingRuntime,
  getImageRuntime,
  getSettings,
  getSpeechRuntime,
  getTelegramBotToken,
  getTranscriptionRuntime,
  getWebSearchApiKey,
  listSectionModels,
  updateSettings,
} from "./service";

// `updateSettings` verifies stored model selections against a repointed
// endpoint by listing its models; a test must never make that network call.
vi.mock("@/server/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/client")>();
  return { ...actual, listModels: vi.fn() };
});

const listModelsMock = vi.mocked(listModels);

/** Seed a known user so the owner can be chosen by id. */
async function seedUser(ctx: TestDb, userId: string, username: string | null) {
  await upsertKnownUser(ctx.db, { userId, username, firstName: null, lastName: null });
}

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  // Endpoint unreachable unless a test says otherwise — the conservative case,
  // in which stored selections are never cleared.
  listModelsMock.mockReset();
  listModelsMock.mockRejectedValue(new Error("model listing unavailable in this test"));
});

const trigger = { kind: "dashboard" } as const;

describe("getSettings", () => {
  it("returns empty defaults when never configured", async () => {
    expect(await getSettings(ctx.db)).toEqual({
      llmBaseUrl: null,
      llmBackend: "openai-compatible",
      model: null,
      apiKeyConfigured: false,
      telegramBotTokenConfigured: false,
      webSearchConfigured: false,
      embeddingBaseUrl: null,
      embeddingBackend: "openai-compatible",
      embeddingModel: null,
      embeddingApiKeyConfigured: false,
      imageBaseUrl: null,
      imageBackend: "openai-compatible",
      imageModel: null,
      imageApiKeyConfigured: false,
      speechBaseUrl: null,
      speechBackend: "openai-compatible",
      speechModel: null,
      speechVoice: null,
      speechApiKeyConfigured: false,
      transcriptionBaseUrl: null,
      transcriptionBackend: "openai-compatible",
      transcriptionModel: null,
      transcriptionApiKeyConfigured: false,
      ownerUsername: null,
      ownerUserId: null,
      maintenanceModeEnabled: false,
      timezone: "UTC",
      dailyJobsRunTime: "04:00",
      browserDownloadLimitGb: 10,
      updatedAt: null,
    });
  });
});

describe("updateSettings", () => {
  it("persists a partial update and merges across writes", async () => {
    const first = await updateSettings(
      { llmBaseUrl: "https://api.openai.com/v1" },
      trigger,
      ctx.db,
    );
    expect(first.llmBaseUrl).toBe("https://api.openai.com/v1");
    expect(first.model).toBeNull();
    expect(first.updatedAt).not.toBeNull();

    const second = await updateSettings({ model: "gpt-4o-mini" }, trigger, ctx.db);
    // Untouched fields survive partial updates.
    expect(second.llmBaseUrl).toBe("https://api.openai.com/v1");
    expect(second.model).toBe("gpt-4o-mini");
  });

  it("stores a valid timezone and rejects an unknown one", async () => {
    const set = await updateSettings({ timezone: "Europe/Berlin" }, trigger, ctx.db);
    expect(set.timezone).toBe("Europe/Berlin");
    await expect(updateSettings({ timezone: "Mars/Phobos" }, trigger, ctx.db)).rejects.toThrow(
      /timezone/i,
    );
  });

  it("persists the daily-jobs run time (validated at the schema boundary)", async () => {
    const set = await updateSettings({ dailyJobsRunTime: "05:30" }, trigger, ctx.db);
    expect(set.dailyJobsRunTime).toBe("05:30");
    // One setting drives every nightly job — both schedulers read this same value.
    expect(await getDailyJobsRunTime(ctx.db)).toBe("05:30");
    // The HH:MM shape is enforced by `updateSettingsSchema` before the service.
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "25:99" }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "3pm" }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ dailyJobsRunTime: "23:45" }).success).toBe(true);
  });

  it("never exposes the API key but reports it as configured, and can clear it", async () => {
    const set = await updateSettings({ apiKey: "sk-secret-123" }, trigger, ctx.db);
    expect(set.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("sk-secret-123");
    // The raw value is stored for provider calls, just not surfaced to clients.
    expect((await getSettingsRecord(ctx.db))?.llmApiKey).toBe("sk-secret-123");

    const cleared = await updateSettings({ apiKey: "" }, trigger, ctx.db);
    expect(cleared.apiKeyConfigured).toBe(false);
    expect((await getSettingsRecord(ctx.db))?.llmApiKey).toBeNull();
  });

  it("stores the Telegram bot token as a masked, server-only secret", async () => {
    const set = await updateSettings({ telegramBotToken: "123:ABC-secret" }, trigger, ctx.db);
    expect(set.telegramBotTokenConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("123:ABC-secret");
    // The raw value is retrievable server-side (for the poller), never via the client shape.
    expect(await getTelegramBotToken(ctx.db)).toBe("123:ABC-secret");

    const cleared = await updateSettings({ telegramBotToken: "" }, trigger, ctx.db);
    expect(cleared.telegramBotTokenConfigured).toBe(false);
    expect(await getTelegramBotToken(ctx.db)).toBeNull();
  });

  it("stores the Tavily API key as a masked, server-only secret", async () => {
    const set = await updateSettings({ tavilyApiKey: "tvly-secret" }, trigger, ctx.db);
    expect(set.webSearchConfigured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("tvly-secret");
    // Retrievable server-side for the web-search tool, never via the client shape.
    expect(await getWebSearchApiKey(ctx.db)).toBe("tvly-secret");

    const cleared = await updateSettings({ tavilyApiKey: "" }, trigger, ctx.db);
    expect(cleared.webSearchConfigured).toBe(false);
    expect(await getWebSearchApiKey(ctx.db)).toBeNull();
  });

  it("redacts secrets from recorded trace data", async () => {
    await updateSettings(
      { apiKey: "sk-secret-456", tavilyApiKey: "tvly-secret-456", model: "m" },
      trigger,
      ctx.db,
    );

    const { traces } = await listTraces({ feature: "settings" });
    expect(traces).toHaveLength(1);
    expect(traces[0].action).toBe("update");
    expect(traces[0].status).toBe("success");

    const detail = await getTraceDetail(traces[0].id);
    const json = JSON.stringify(detail.events);
    expect(json).not.toContain("sk-secret-456");
    expect(json).not.toContain("tvly-secret-456");
  });

  it("keeps a single row across many updates", async () => {
    await updateSettings({ model: "a" }, trigger, ctx.db);
    await updateSettings({ model: "b" }, trigger, ctx.db);

    const rows = await ctx.db.execute("SELECT COUNT(*)::int AS count FROM settings");
    expect(Number((rows.rows[0] as { count: number }).count)).toBe(1);
  });

  it("sets the owner from a known user (denormalizing the username) and toggles maintenance", async () => {
    await seedUser(ctx, "555", "ownername");

    const set = await updateSettings(
      { ownerUserId: "555", maintenanceModeEnabled: true },
      trigger,
      ctx.db,
    );
    expect(set.ownerUserId).toBe("555");
    expect(set.ownerUsername).toBe("ownername");
    expect(set.maintenanceModeEnabled).toBe(true);

    const off = await updateSettings({ maintenanceModeEnabled: false }, trigger, ctx.db);
    // Untouched owner survives a maintenance-only update.
    expect(off.ownerUserId).toBe("555");
    expect(off.maintenanceModeEnabled).toBe(false);
  });

  it("rejects an owner id that is not a known user", async () => {
    await expect(updateSettings({ ownerUserId: "404" }, trigger, ctx.db)).rejects.toThrow(
      /not a known user/i,
    );
  });

  it("clears the owner when passed null", async () => {
    await seedUser(ctx, "555", "ownername");
    await updateSettings({ ownerUserId: "555" }, trigger, ctx.db);

    const cleared = await updateSettings({ ownerUserId: null }, trigger, ctx.db);
    expect(cleared.ownerUserId).toBeNull();
    expect(cleared.ownerUsername).toBeNull();
  });
});

describe("updateSettings — stale model selections", () => {
  /** One endpoint, a model picked on it for every capability. */
  async function seed() {
    await updateSettings(
      {
        llmBaseUrl: "http://old-backend.local/v1",
        model: "chat-old",
        embeddingModel: "embed-old",
        imageModel: "image-old",
        speechModel: "speech-old",
        transcriptionModel: "whisper-old",
      },
      trigger,
      ctx.db,
    );
  }

  it("clears selections the repointed endpoint verifiably does not serve (transcription exempt)", async () => {
    await seed();
    listModelsMock.mockResolvedValue(["chat-new"]);

    const updated = await updateSettings(
      { llmBaseUrl: "http://new-backend.local/v1" },
      trigger,
      ctx.db,
    );

    expect(updated.model).toBeNull();
    expect(updated.embeddingModel).toBeNull();
    expect(updated.imageModel).toBeNull();
    expect(updated.speechModel).toBeNull();
    // Whisper-class servers often expose no listing, so absence proves nothing.
    expect(updated.transcriptionModel).toBe("whisper-old");
    // Four sections share one endpoint: one listing, not four.
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(listModelsMock).toHaveBeenCalledWith(
      { baseUrl: "http://new-backend.local/v1", apiKey: null },
      expect.any(Number),
    );
  });

  it("keeps selections the repointed endpoint still serves", async () => {
    await seed();
    listModelsMock.mockResolvedValue(["chat-old", "embed-old", "image-old", "speech-old"]);

    const updated = await updateSettings(
      { llmBaseUrl: "http://new-backend.local/v1" },
      trigger,
      ctx.db,
    );

    expect(updated.model).toBe("chat-old");
    expect(updated.embeddingModel).toBe("embed-old");
    expect(updated.imageModel).toBe("image-old");
    expect(updated.speechModel).toBe("speech-old");
  });

  it("clears nothing when the new endpoint cannot be listed — absence must be proven", async () => {
    await seed();
    listModelsMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const updated = await updateSettings(
      { llmBaseUrl: "http://new-backend.local/v1" },
      trigger,
      ctx.db,
    );

    expect(updated.model).toBe("chat-old");
    expect(updated.embeddingModel).toBe("embed-old");
    const { traces } = await listTraces({ feature: "settings" });
    const detail = await getTraceDetail(traces[0].id);
    expect(JSON.stringify(detail.events)).toContain("Could not list models");
  });

  it("trusts a model chosen in the same patch and validates the rest", async () => {
    await seed();
    listModelsMock.mockResolvedValue(["something-else"]);

    const updated = await updateSettings(
      { llmBaseUrl: "http://new-backend.local/v1", model: "picked-by-hand" },
      trigger,
      ctx.db,
    );

    expect(updated.model).toBe("picked-by-hand");
    expect(updated.embeddingModel).toBeNull();
  });

  it("leaves a section with its own endpoint alone when the LLM URL changes", async () => {
    await seed();
    await updateSettings(
      { embeddingBaseUrl: "http://embed.local/v1", embeddingModel: "embed-own" },
      trigger,
      ctx.db,
    );
    listModelsMock.mockResolvedValue(["chat-new"]);

    const updated = await updateSettings(
      { llmBaseUrl: "http://new-backend.local/v1" },
      trigger,
      ctx.db,
    );

    expect(updated.model).toBeNull();
    expect(updated.embeddingModel).toBe("embed-own");
  });

  it("validates against the LLM endpoint when a section falls back to it", async () => {
    await seed();
    await updateSettings(
      { embeddingBaseUrl: "http://embed.local/v1", embeddingModel: "embed-own" },
      trigger,
      ctx.db,
    );
    listModelsMock.mockResolvedValue(["chat-old", "image-old", "speech-old"]);

    const updated = await updateSettings({ embeddingBaseUrl: null }, trigger, ctx.db);

    // "embed-own" was picked on the dropped host; the LLM endpoint has no such model.
    expect(updated.embeddingModel).toBeNull();
    // The LLM endpoint itself did not move — its own model is not even checked.
    expect(updated.model).toBe("chat-old");
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(listModelsMock).toHaveBeenCalledWith(
      { baseUrl: "http://old-backend.local/v1", apiKey: null },
      expect.any(Number),
    );
  });

  it("records what was cleared on the trace", async () => {
    await seed();
    listModelsMock.mockResolvedValue(["chat-new", "embed-old", "image-old", "speech-old"]);

    await updateSettings({ llmBaseUrl: "http://new-backend.local/v1" }, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "settings" });
    expect(traces[0].outputSummary).toContain("cleared stale chat model");
    const detail = await getTraceDetail(traces[0].id);
    const messages = detail.events.map((e) => e.message);
    expect(messages).toContain(
      'Cleared chat model — "chat-old" is not served by http://new-backend.local/v1',
    );
  });

  it("does not list models unless a base URL changes", async () => {
    await seed();
    await updateSettings({ model: "chat-newer" }, trigger, ctx.db);
    expect(listModelsMock).not.toHaveBeenCalled();
  });
});

describe("getBotPolicy", () => {
  it("reads the owner id and maintenance flag", async () => {
    await seedUser(ctx, "999", "ownername");
    await updateSettings({ ownerUserId: "999", maintenanceModeEnabled: true }, trigger, ctx.db);

    const policy = await getBotPolicy(ctx.db);
    expect(policy).toEqual({ ownerUserId: "999", maintenanceModeEnabled: true });
  });

  it("defaults to no owner and maintenance off when unconfigured", async () => {
    expect(await getBotPolicy(ctx.db)).toEqual({
      ownerUserId: null,
      maintenanceModeEnabled: false,
    });
  });
});

describe("embedding configuration", () => {
  it("stores the embedding endpoint and never returns its key", async () => {
    const settings = await updateSettings(
      {
        embeddingBaseUrl: "https://embeddings.example.com/v1",
        embeddingApiKey: "secret-embed-key",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    expect(settings.embeddingBaseUrl).toBe("https://embeddings.example.com/v1");
    expect(settings.embeddingModel).toBe("bge-m3");
    expect(settings.embeddingApiKeyConfigured).toBe(true);
    // The value itself never round-trips to a client.
    expect(JSON.stringify(settings)).not.toContain("secret-embed-key");
    // …but it is stored, so the server can actually call the endpoint.
    expect((await getSettingsRecord(ctx.db))?.embeddingApiKey).toBe("secret-embed-key");
  });

  it("redacts the embedding key from the trace", async () => {
    await updateSettings({ embeddingApiKey: "secret-embed-key" }, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "settings" });
    expect(JSON.stringify(traces)).not.toContain("secret-embed-key");
  });

  it("falls back to the LLM connection when no embedding endpoint is set", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    // Chat and embeddings share a host in the common case, so the LLM's URL *and*
    // its key are used — a key belongs to the host it authenticates.
    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "llm-key",
      model: "bge-m3",
    });
  });

  it("uses the embedding endpoint's own key when it has its own URL", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        embeddingBaseUrl: "https://embeddings.example.com/v1",
        embeddingApiKey: "embed-key",
        embeddingModel: "bge-m3",
      },
      trigger,
      ctx.db,
    );

    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://embeddings.example.com/v1",
      apiKey: "embed-key",
      model: "bge-m3",
    });
  });

  it("is unconfigured (not half-configured) without a model", async () => {
    await updateSettings(
      { llmBaseUrl: "https://llm.example.com/v1", model: "gemma3" },
      trigger,
      ctx.db,
    );

    // No embedding model → semantic recall is off, rather than guessing a model id.
    expect(await getEmbeddingRuntime(ctx.db)).toBeNull();
  });

});

describe("image runtime", () => {
  it("falls back to the LLM connection when no image endpoint is set", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        imageModel: "sdxl",
      },
      trigger,
      ctx.db,
    );

    // Same rule as embeddings: the key belongs to the host it authenticates.
    expect(await getImageRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "llm-key",
      model: "sdxl",
    });
  });

  it("uses the image endpoint's own key when it has its own URL", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        imageBaseUrl: "https://images.example.com/v1",
        imageApiKey: "image-key",
        imageModel: "sdxl",
      },
      trigger,
      ctx.db,
    );

    expect(await getImageRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://images.example.com/v1",
      apiKey: "image-key",
      model: "sdxl",
    });
  });

  it("is unconfigured (not half-configured) without a model", async () => {
    await updateSettings(
      { llmBaseUrl: "https://llm.example.com/v1", model: "gemma3" },
      trigger,
      ctx.db,
    );

    // No image model → the tool reports images are unavailable, rather than the
    // provider being called with a guessed model id.
    expect(await getImageRuntime(ctx.db)).toBeNull();
  });

  it("never exposes the image key, but stores it", async () => {
    const settings = await updateSettings(
      { imageApiKey: "secret-image-key" },
      trigger,
      ctx.db,
    );

    expect(settings.imageApiKeyConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("secret-image-key");
    expect((await getSettingsRecord(ctx.db))?.imageApiKey).toBe("secret-image-key");
  });

  it("redacts the image key from the trace", async () => {
    await updateSettings({ imageApiKey: "secret-image-key" }, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "settings" });
    expect(JSON.stringify(traces)).not.toContain("secret-image-key");
  });
});

describe("speech runtime", () => {
  it("falls back to the LLM connection when no speech endpoint is set", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        speechModel: "kokoro",
        speechVoice: "alloy",
      },
      trigger,
      ctx.db,
    );

    // Same rule as embeddings/images: the key belongs to the host it authenticates.
    expect(await getSpeechRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "llm-key",
      model: "kokoro",
      voice: "alloy",
    });
  });

  it("uses the speech endpoint's own key when it has its own URL", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        speechBaseUrl: "https://speech.example.com/v1",
        speechApiKey: "speech-key",
        speechModel: "kokoro",
      },
      trigger,
      ctx.db,
    );

    expect(await getSpeechRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://speech.example.com/v1",
      apiKey: "speech-key",
      model: "kokoro",
      voice: null,
    });
  });

  it("is unconfigured (not half-configured) without a model", async () => {
    await updateSettings(
      { llmBaseUrl: "https://llm.example.com/v1", model: "gemma3" },
      trigger,
      ctx.db,
    );

    // No speech model → voice replies degrade to text, rather than the endpoint
    // being called with a guessed model id.
    expect(await getSpeechRuntime(ctx.db)).toBeNull();
  });

  it("never exposes the speech key, but stores it — and redacts it from the trace", async () => {
    const settings = await updateSettings({ speechApiKey: "secret-speech-key" }, trigger, ctx.db);

    expect(settings.speechApiKeyConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("secret-speech-key");
    expect((await getSettingsRecord(ctx.db))?.speechApiKey).toBe("secret-speech-key");

    const { traces } = await listTraces({ feature: "settings" });
    expect(JSON.stringify(traces)).not.toContain("secret-speech-key");
  });
});

describe("transcription runtime", () => {
  it("falls back to the LLM connection when no transcription endpoint is set", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        transcriptionModel: "whisper-1",
      },
      trigger,
      ctx.db,
    );

    expect(await getTranscriptionRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "llm-key",
      model: "whisper-1",
    });
  });

  it("uses the transcription endpoint's own key when it has its own URL", async () => {
    await updateSettings(
      {
        llmBaseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key",
        model: "gemma3",
        transcriptionBaseUrl: "https://whisper.example.com/v1",
        transcriptionApiKey: "stt-key",
        transcriptionModel: "large-v3",
      },
      trigger,
      ctx.db,
    );

    expect(await getTranscriptionRuntime(ctx.db)).toEqual({
      backend: "openai-compatible",
      baseUrl: "https://whisper.example.com/v1",
      apiKey: "stt-key",
      model: "large-v3",
    });
  });

  it("is unconfigured without a model — voice then falls back to the chat model", async () => {
    await updateSettings(
      { llmBaseUrl: "https://llm.example.com/v1", model: "gemma3" },
      trigger,
      ctx.db,
    );

    expect(await getTranscriptionRuntime(ctx.db)).toBeNull();
  });

  it("never exposes the transcription key, but stores it — and redacts it from the trace", async () => {
    const settings = await updateSettings(
      { transcriptionApiKey: "secret-stt-key" },
      trigger,
      ctx.db,
    );

    expect(settings.transcriptionApiKeyConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("secret-stt-key");
    expect((await getSettingsRecord(ctx.db))?.transcriptionApiKey).toBe("secret-stt-key");

    const { traces } = await listTraces({ feature: "settings" });
    expect(JSON.stringify(traces)).not.toContain("secret-stt-key");
  });
});

describe("listSectionModels", () => {
  it("lists from the given URL with the typed key when one is provided", async () => {
    listModelsMock.mockResolvedValue(["embed-a", "embed-b"]);

    const { models } = await listSectionModels(
      { section: "embedding", baseUrl: "https://new-host.example.com/v1", apiKey: "typed-key" },
      ctx.db,
    );

    expect(models).toEqual(["embed-a", "embed-b"]);
    expect(listModelsMock).toHaveBeenCalledWith(
      { baseUrl: "https://new-host.example.com/v1", apiKey: "typed-key" },
      expect.any(Number),
    );
  });

  it("falls back to the section's stored key when none is typed", async () => {
    await upsertSettings(ctx.db, { embeddingApiKey: "stored-embed-key" });
    listModelsMock.mockResolvedValue(["embed-a"]);

    await listSectionModels(
      { section: "embedding", baseUrl: "https://new-host.example.com/v1" },
      ctx.db,
    );

    expect(listModelsMock).toHaveBeenCalledWith(
      { baseUrl: "https://new-host.example.com/v1", apiKey: "stored-embed-key" },
      expect.any(Number),
    );
  });

  it("an explicit null key means no key, never the stored one", async () => {
    await upsertSettings(ctx.db, { imageApiKey: "stored-image-key" });
    listModelsMock.mockResolvedValue([]);

    await listSectionModels(
      { section: "image", baseUrl: "https://new-host.example.com/v1", apiKey: null },
      ctx.db,
    );

    expect(listModelsMock).toHaveBeenCalledWith(
      { baseUrl: "https://new-host.example.com/v1", apiKey: null },
      expect.any(Number),
    );
  });

  it("propagates a listing failure so the form can say why the list is empty", async () => {
    await expect(
      listSectionModels({ section: "speech", baseUrl: "https://dead.example.com/v1" }, ctx.db),
    ).rejects.toThrow();
  });
});
