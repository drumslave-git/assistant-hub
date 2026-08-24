import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { insertBackend } from "@/features/backends/server/repository";
import { upsertKnownUser } from "@/features/known-users/server/repository";
import type { LlmBackendId } from "@/lib/llm-backend";
import { chatCompletion, listModels } from "@/server/llm/client";
import { probeEmbeddings } from "@/server/llm/embeddings";
import { probeImages } from "@/server/llm/images";
import { probeSpeech } from "@/server/llm/speech";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { getTraceDetail, listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import { getSettingsRecord } from "./repository";
import { updateSettingsSchema, type ProbeReport } from "./schema";
import {
  getAudioRuntime,
  getBackgroundRuntime,
  getBotPolicy,
  getBrowserLlmRuntime,
  getClassifierRuntime,
  getDailyJobsRunTime,
  getEmbeddingRuntime,
  getImageRuntime,
  getLlmRuntime,
  getSettings,
  getSpeechRuntime,
  getVisionRuntime,
  getWebSearchApiKey,
  testAudio,
  testBackground,
  testBrowser,
  testChat,
  testClassifier,
  testEmbeddings,
  testImages,
  testSpeech,
  testVision,
  updateSettings,
} from "./service";

// `updateSettings` verifies stored model selections against a repointed
// backend by listing its models; a test must never make that network call.
vi.mock("@/server/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/client")>();
  return { ...actual, listModels: vi.fn(), chatCompletion: vi.fn() };
});

// Owner identity routes to the tg source app since the split; the operator
// client is mocked so the write is asserted, not performed.
vi.mock("@/server/source/tg-operator", () => ({
  saveSourceOwner: vi.fn(),
}));

// The browser probe runs a tool round rather than a plain completion.
vi.mock("@/server/llm/tool-loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/tool-loop")>();
  return { ...actual, chatCompletionWithTools: vi.fn() };
});

// The embedding/image/speech probes now do real work through the AI SDK. What
// belongs here is how the service turns their result into a report, so the
// probe calls themselves are stubbed and the mapping is what gets asserted.
vi.mock("@/server/llm/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/embeddings")>();
  return { ...actual, probeEmbeddings: vi.fn() };
});
vi.mock("@/server/llm/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/images")>();
  return { ...actual, probeImages: vi.fn() };
});
vi.mock("@/server/llm/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/speech")>();
  return { ...actual, probeSpeech: vi.fn() };
});

const listModelsMock = vi.mocked(listModels);
const chatCompletionMock = vi.mocked(chatCompletion);
const chatCompletionWithToolsMock = vi.mocked(chatCompletionWithTools);
const probeEmbeddingsMock = vi.mocked(probeEmbeddings);
const probeImagesMock = vi.mocked(probeImages);
const probeSpeechMock = vi.mocked(probeSpeech);

/** Seed a known user so the owner can be chosen by id. */
async function seedUser(ctx: TestDb, userId: string, username: string | null) {
  await upsertKnownUser(ctx.db, { userId, username, firstName: null, lastName: null });
}

/** Seed one backend row and return its id. */
async function seedBackend(
  ctx: TestDb,
  values: { name: string; baseUrl: string; apiKey?: string | null; type?: LlmBackendId },
): Promise<string> {
  const id = randomUUID();
  await insertBackend(ctx.db, id, {
    name: values.name,
    baseUrl: values.baseUrl,
    apiKey: values.apiKey ?? null,
    type: values.type ?? "openai-compatible",
  });
  return id;
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
  chatCompletionMock.mockReset();
  chatCompletionMock.mockRejectedValue(new Error("chat completion unavailable in this test"));
  chatCompletionWithToolsMock.mockReset();
  chatCompletionWithToolsMock.mockRejectedValue(
    new Error("tool completion unavailable in this test"),
  );
  for (const mock of [probeEmbeddingsMock, probeImagesMock, probeSpeechMock]) {
    mock.mockReset();
    mock.mockRejectedValue(new Error("probe unavailable in this test"));
  }
});

const trigger = { kind: "dashboard" } as const;

describe("getSettings", () => {
  it("returns empty defaults when never configured", async () => {
    expect(await getSettings(ctx.db)).toEqual({
      chatBackendId: null,
      model: null,
      embeddingBackendId: null,
      embeddingModel: null,
      imageBackendId: null,
      imageModel: null,
      speechBackendId: null,
      speechModel: null,
      speechVoice: null,
      audioBackendId: null,
      audioModel: null,
      audioTranscriptionMode: "transcriptions",
      visionBackendId: null,
      visionModel: null,
      classifierBackendId: null,
      classifierModel: null,
      backgroundBackendId: null,
      backgroundModel: null,
      browserBackendId: null,
      browserModel: null,
      webSearchConfigured: false,
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
    const backendId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    const first = await updateSettings({ chatBackendId: backendId }, trigger, ctx.db);
    expect(first.chatBackendId).toBe(backendId);
    expect(first.model).toBeNull();
    expect(first.updatedAt).not.toBeNull();

    const second = await updateSettings({ model: "gpt-4o-mini" }, trigger, ctx.db);
    // Untouched fields survive partial updates.
    expect(second.chatBackendId).toBe(backendId);
    expect(second.model).toBe("gpt-4o-mini");
  });

  it("rejects a backend id that is not in the catalog", async () => {
    await expect(
      updateSettings({ chatBackendId: "no-such-backend" }, trigger, ctx.db),
    ).rejects.toThrow(/unknown backend/i);
    await expect(
      updateSettings({ visionBackendId: "no-such-backend" }, trigger, ctx.db),
    ).rejects.toThrow(/unknown backend/i);
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

  it("takes no bot token — connections are per assistant since Phase 3", async () => {
    // The schema strips the retired key, leaving an empty (rejected) update;
    // nothing token-shaped can land in this database through settings.
    expect(updateSettingsSchema.safeParse({ telegramBotToken: "12345:x" }).success).toBe(false);
    expect((await getSettingsRecord(ctx.db))?.telegramBotToken ?? null).toBeNull();
  });

  it("stores the Tavily key write-only and redacts it from the trace", async () => {
    const set = await updateSettings({ tavilyApiKey: "tvly-secret" }, trigger, ctx.db);
    expect(set.webSearchConfigured).toBe(true);
    expect(await getWebSearchApiKey(ctx.db)).toBe("tvly-secret");

    const traces = await listTraces({ feature: "settings" });
    const detail = await getTraceDetail(traces.traces[0].id);
    expect(JSON.stringify(detail)).not.toContain("tvly-secret");
  });

  it("resolves the owner from known users and denormalizes the username", async () => {
    await seedUser(ctx, "42", "operator");
    const set = await updateSettings({ ownerUserId: "42" }, trigger, ctx.db);
    expect(set.ownerUserId).toBe("42");
    expect(set.ownerUsername).toBe("operator");
    // Owner identity is the source's since the split — the policy carries
    // only maintenance state; the columns above stay as display data.
    expect(await getBotPolicy(ctx.db)).toEqual({ maintenanceModeEnabled: false });

    await expect(updateSettings({ ownerUserId: "999" }, trigger, ctx.db)).rejects.toThrow(
      /known user/i,
    );
  });

  it("persists every role's backend + model selection", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    const otherId = await seedBackend(ctx, { name: "GPU box", baseUrl: "https://gpu.example/v1" });
    const set = await updateSettings(
      {
        chatBackendId: chatId,
        model: "chat-model",
        embeddingBackendId: otherId,
        embeddingModel: "bge-m3",
        audioBackendId: otherId,
        audioModel: "whisper-1",
        visionModel: "gemma-vision",
        browserBackendId: otherId,
        speechModel: "kokoro",
        speechVoice: "alloy",
        imageModel: "sdxl",
      },
      trigger,
      ctx.db,
    );
    expect(set.embeddingBackendId).toBe(otherId);
    expect(set.embeddingModel).toBe("bge-m3");
    expect(set.audioModel).toBe("whisper-1");
    expect(set.visionBackendId).toBeNull();
    expect(set.visionModel).toBe("gemma-vision");
    expect(set.browserBackendId).toBe(otherId);
    expect(set.browserModel).toBeNull();
    expect(set.speechVoice).toBe("alloy");
    expect(set.imageModel).toBe("sdxl");
  });
});

describe("role runtimes", () => {
  it("getLlmRuntime resolves the chat backend row, and is null while unconfigured", async () => {
    expect(await getLlmRuntime(ctx.db)).toBeNull();
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      type: "ollama",
    });
    await updateSettings({ chatBackendId: chatId }, trigger, ctx.db);
    // A backend without a model is still not a runnable chat configuration.
    expect(await getLlmRuntime(ctx.db)).toBeNull();
    await updateSettings({ model: "gemma" }, trigger, ctx.db);
    expect(await getLlmRuntime(ctx.db)).toEqual({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      model: "gemma",
      backend: "ollama",
    });
  });

  it("embedding/image/speech inherit the chat backend and stay off without a model", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      type: "llamacpp",
    });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);

    // No model → the capability is off, never guessed.
    expect(await getEmbeddingRuntime(ctx.db)).toBeNull();
    expect(await getImageRuntime(ctx.db)).toBeNull();
    expect(await getSpeechRuntime(ctx.db)).toBeNull();

    await updateSettings(
      { embeddingModel: "bge-m3", imageModel: "sdxl", speechModel: "kokoro", speechVoice: "sky" },
      trigger,
      ctx.db,
    );
    // The backend (and its key and type) follow the chat host.
    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      backend: "llamacpp",
      model: "bge-m3",
    });
    expect(await getImageRuntime(ctx.db)).toMatchObject({ model: "sdxl" });
    expect(await getSpeechRuntime(ctx.db)).toMatchObject({ model: "kokoro", voice: "sky" });
  });

  it("a role with its own backend resolves that host, key and type", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    const embId = await seedBackend(ctx, {
      name: "Embeddings",
      baseUrl: "https://embed.example/v1",
      apiKey: "sk-embed",
      type: "vllm",
    });
    await updateSettings(
      { chatBackendId: chatId, model: "gemma", embeddingBackendId: embId, embeddingModel: "bge-m3" },
      trigger,
      ctx.db,
    );
    expect(await getEmbeddingRuntime(ctx.db)).toEqual({
      baseUrl: "https://embed.example/v1",
      apiKey: "sk-embed",
      backend: "vllm",
      model: "bge-m3",
    });
  });

  it("audio requires its own model (null → chat-model input_audio fallback)", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    // Deliberately NOT falling back to the chat model: a chat model id on
    // /v1/audio/transcriptions would be a guessed, wrong call.
    expect(await getAudioRuntime(ctx.db)).toBeNull();

    await updateSettings({ audioModel: "whisper-1" }, trigger, ctx.db);
    expect(await getAudioRuntime(ctx.db)).toMatchObject({
      baseUrl: "https://llm.example/v1",
      model: "whisper-1",
      mode: "transcriptions",
    });
  });

  it("audio transcription mode round-trips and reaches the runtime", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    const set = await updateSettings(
      {
        chatBackendId: chatId,
        model: "gemma",
        audioModel: "omni-model",
        audioTranscriptionMode: "chat",
      },
      trigger,
      ctx.db,
    );
    expect(set.audioTranscriptionMode).toBe("chat");
    expect(await getAudioRuntime(ctx.db)).toMatchObject({ model: "omni-model", mode: "chat" });
  });

  it("vision and browser fall back to the chat backend and model per unset half", async () => {
    expect(await getVisionRuntime(ctx.db)).toBeNull();
    expect(await getBrowserLlmRuntime(ctx.db)).toBeNull();

    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      type: "ollama",
    });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);

    // Fully unset: exactly the chat connection ("main by default").
    expect(await getVisionRuntime(ctx.db)).toEqual({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      model: "gemma",
      backend: "ollama",
    });
    expect(await getBrowserLlmRuntime(ctx.db)).toMatchObject({ model: "gemma" });

    // Model overridden, backend inherited.
    await updateSettings({ visionModel: "gemma-vision" }, trigger, ctx.db);
    expect(await getVisionRuntime(ctx.db)).toMatchObject({
      baseUrl: "https://llm.example/v1",
      model: "gemma-vision",
    });

    // Backend overridden too.
    const gpuId = await seedBackend(ctx, { name: "GPU", baseUrl: "https://gpu.example/v1" });
    await updateSettings({ browserBackendId: gpuId, browserModel: "qwen-long" }, trigger, ctx.db);
    expect(await getBrowserLlmRuntime(ctx.db)).toMatchObject({
      baseUrl: "https://gpu.example/v1",
      model: "qwen-long",
    });
  });

  it("classifier and background roles fall back to chat, then take their own model", async () => {
    // Unconfigured chat means neither aux role resolves either: they have
    // nothing to inherit.
    expect(await getClassifierRuntime(ctx.db)).toBeNull();
    expect(await getBackgroundRuntime(ctx.db)).toBeNull();

    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      type: "vllm",
    });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);

    // The whole point of the default: an installation that never opens these
    // tabs behaves exactly as it did before the roles existed.
    expect(await getClassifierRuntime(ctx.db)).toEqual({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      model: "gemma",
      backend: "vllm",
    });
    expect(await getBackgroundRuntime(ctx.db)).toMatchObject({ model: "gemma" });

    // A small fast model for the per-message checks, on the same host.
    await updateSettings({ classifierModel: "qwen-0.5b" }, trigger, ctx.db);
    expect(await getClassifierRuntime(ctx.db)).toMatchObject({
      baseUrl: "https://llm.example/v1",
      model: "qwen-0.5b",
    });
    // …which must not drag the background jobs (or replies) along with it.
    expect(await getBackgroundRuntime(ctx.db)).toMatchObject({ model: "gemma" });
    expect(await getLlmRuntime(ctx.db)).toMatchObject({ model: "gemma" });

    // A long-context model on another host for the nightly work.
    const gpuId = await seedBackend(ctx, { name: "GPU", baseUrl: "https://gpu.example/v1" });
    await updateSettings(
      { backgroundBackendId: gpuId, backgroundModel: "qwen-long" },
      trigger,
      ctx.db,
    );
    expect(await getBackgroundRuntime(ctx.db)).toMatchObject({
      baseUrl: "https://gpu.example/v1",
      model: "qwen-long",
    });
  });
});

describe("stale model clearing on save", () => {
  /** Configure chat + inheriting roles with stored models. */
  async function seedConfigured() {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://old.example/v1" });
    await updateSettings(
      {
        chatBackendId: chatId,
        model: "chat-model",
        embeddingModel: "bge-m3",
        imageModel: "sdxl",
        audioModel: "whisper-1",
        visionModel: "gemma-vision",
      },
      trigger,
      ctx.db,
    );
    return chatId;
  }

  it("repointing the chat backend clears inheriting models the new backend does not serve", async () => {
    await seedConfigured();
    const newId = await seedBackend(ctx, { name: "New", baseUrl: "https://new.example/v1" });
    // The new backend serves the embedding model but not chat/image/vision.
    listModelsMock.mockResolvedValue(["bge-m3", "other-model"]);

    const set = await updateSettings({ chatBackendId: newId }, trigger, ctx.db);
    expect(set.model).toBeNull();
    expect(set.imageModel).toBeNull();
    expect(set.visionModel).toBeNull();
    // Served → kept.
    expect(set.embeddingModel).toBe("bge-m3");
    // Audio is exempt in `transcriptions` mode (the default here): whisper-class
    // servers often list nothing, so absence from a listing proves nothing.
    expect(set.audioModel).toBe("whisper-1");
    // One listing for the one distinct backend.
    expect(listModelsMock).toHaveBeenCalledTimes(1);
  });

  it("in chat transcription mode the audio model is verified and cleared like any listed role", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://old.example/v1" });
    await updateSettings(
      {
        chatBackendId: chatId,
        model: "chat-model",
        audioModel: "omni-model",
        audioTranscriptionMode: "chat",
      },
      trigger,
      ctx.db,
    );
    const newId = await seedBackend(ctx, { name: "New", baseUrl: "https://new.example/v1" });
    // The new backend serves the chat model but not the audio one — and in chat
    // mode the audio model is an ordinary chat model, so its absence is proof.
    listModelsMock.mockResolvedValue(["chat-model"]);

    const set = await updateSettings({ chatBackendId: newId }, trigger, ctx.db);
    expect(set.model).toBe("chat-model");
    expect(set.audioModel).toBeNull();
  });

  it("clears nothing when the new backend cannot be listed, and records why", async () => {
    await seedConfigured();
    const newId = await seedBackend(ctx, { name: "New", baseUrl: "https://dead.example/v1" });
    listModelsMock.mockRejectedValue(new Error("connection refused"));

    const set = await updateSettings({ chatBackendId: newId }, trigger, ctx.db);
    expect(set.model).toBe("chat-model");
    expect(set.embeddingModel).toBe("bge-m3");

    const traces = await listTraces({ feature: "settings" });
    const detail = await getTraceDetail(traces.traces[0].id);
    expect(JSON.stringify(detail)).toContain("left unchanged");
  });

  it("trusts a model picked in the same patch", async () => {
    await seedConfigured();
    const newId = await seedBackend(ctx, { name: "New", baseUrl: "https://new.example/v1" });
    listModelsMock.mockResolvedValue(["fresh-model"]);

    const set = await updateSettings(
      { chatBackendId: newId, model: "fresh-model" },
      trigger,
      ctx.db,
    );
    expect(set.model).toBe("fresh-model");
  });

  it("leaves a role with its own backend untouched by a chat repoint", async () => {
    const chatId = await seedConfigured();
    const embId = await seedBackend(ctx, { name: "Embed", baseUrl: "https://embed.example/v1" });
    await updateSettings({ embeddingBackendId: embId }, trigger, ctx.db);
    listModelsMock.mockClear();
    listModelsMock.mockResolvedValue([]);

    const newId = await seedBackend(ctx, { name: "New", baseUrl: "https://new.example/v1" });
    const set = await updateSettings({ chatBackendId: newId }, trigger, ctx.db);
    // The embedding role kept its own backend; its model was not checked
    // against the new chat backend.
    expect(set.embeddingModel).toBe("bge-m3");
    expect(set.model).toBeNull();
    void chatId;
  });

  it("repointing one role's own backend verifies only that role", async () => {
    await seedConfigured();
    const embId = await seedBackend(ctx, { name: "Embed", baseUrl: "https://embed.example/v1" });
    listModelsMock.mockResolvedValue(["something-else"]);

    const set = await updateSettings({ embeddingBackendId: embId }, trigger, ctx.db);
    expect(set.embeddingModel).toBeNull();
    // Chat and the other inheriting roles were not repointed — untouched.
    expect(set.model).toBe("chat-model");
    expect(set.imageModel).toBe("sdxl");
  });

  it("does not list models at all when no backend id changes", async () => {
    await seedConfigured();
    listModelsMock.mockClear();
    await updateSettings({ speechVoice: "sky" }, trigger, ctx.db);
    expect(listModelsMock).not.toHaveBeenCalled();
  });
});

describe("connection probes", () => {
  /** A minimal successful completion, shaped like the real client returns. */
  function completion(content: string, model: string, reasoning?: string) {
    const message = reasoning ? { content, reasoning_content: reasoning } : { content };
    return {
      content,
      model,
      latencyMs: 5,
      requestBody: {},
      responseBody: { choices: [{ message }] },
    };
  }

  /** The text a probe reported under one label, on the sent or received side. */
  function partText(report: ProbeReport, side: "input" | "output", label: string): string {
    const part = report[side].find((p) => p.label === label);
    if (!part) throw new Error(`report has no ${side} part labelled "${label}"`);
    if (part.kind !== "text") throw new Error(`part "${label}" is a ${part.kind}, not text`);
    return part.text;
  }

  /** The part a probe reported under one label, whatever its kind. */
  function part(report: ProbeReport, side: "input" | "output", label: string) {
    const found = report[side].find((p) => p.label === label);
    if (!found) throw new Error(`report has no ${side} part labelled "${label}"`);
    return found;
  }

  it("testChat completes a prompt and reports the answer with its reasoning", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
      type: "vllm",
    });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(
      completion("Paris, on the Seine.", "gemma", "thinking about France"),
    );

    const probe = await testChat({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");
    expect(partText(probe, "output", "Message")).toBe("Paris, on the Seine.");
    // The hidden channel is the half a listing could never show.
    expect(partText(probe, "output", "Reasoning")).toBe("thinking about France");
    // A real completion, against the chat connection.
    const [conn, input] = chatCompletionMock.mock.calls[0];
    expect(conn.baseUrl).toBe("https://llm.example/v1");
    expect(input.model).toBe("gemma");
  });

  it("testChat names an absent reasoning channel instead of hiding it", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(completion("Paris.", "gemma"));

    const probe = await testChat({}, trigger, ctx.db);
    // A model that should think and did not is a finding, not a blank.
    expect(partText(probe, "output", "Reasoning")).toMatch(/none returned/i);
  });

  it("testChat rejects cleanly when the chat role is unconfigured", async () => {
    await expect(testChat({}, trigger, ctx.db)).rejects.toThrow(/chat backend and model/i);
  });

  it("testImages generates a picture and reports the prompt beside it", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma", imageModel: "sdxl" }, trigger, ctx.db);
    probeImagesMock.mockResolvedValue({
      model: "sdxl",
      prompt: "A single red circle centered on a white background.",
      imageBase64: "aW1hZ2VieXRlcw==",
    });

    const probe = await testImages({}, trigger, ctx.db);
    expect(partText(probe, "input", "Prompt")).toMatch(/red circle/i);
    const image = part(probe, "output", "Generated image");
    expect(image.kind).toBe("image");
    // The real bytes reach the dashboard, which is the point of the probe.
    expect(image.kind === "image" && image.dataUrl).toBe("data:image/png;base64,aW1hZ2VieXRlcw==");
  });

  it("testSpeech synthesizes the phrase and reports the voice it used", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings(
      { chatBackendId: chatId, model: "gemma", speechModel: "tts-1", speechVoice: "sky" },
      trigger,
      ctx.db,
    );
    probeSpeechMock.mockResolvedValue({
      model: "tts-1",
      phrase: "This is a voice test.",
      voice: "sky",
      audioBase64: "YXVkaW8=",
    });

    const probe = await testSpeech({}, trigger, ctx.db);
    // The voice is the half a model listing cannot check, so it is reported.
    expect(partText(probe, "input", "Voice")).toBe("sky");
    const audio = part(probe, "output", "Synthesized audio");
    expect(audio.kind === "audio" && audio.dataUrl).toBe("data:audio/mpeg;base64,YXVkaW8=");
  });

  it("testEmbeddings reports the phrase and the vector it produced", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings(
      { chatBackendId: chatId, model: "gemma", embeddingModel: "bge-m3" },
      trigger,
      ctx.db,
    );
    const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
    probeEmbeddingsMock.mockResolvedValue({
      model: "bge-m3",
      phrase: "The quick brown fox jumps over the lazy dog.",
      dimensions: vector.length,
      vector,
    });

    const probe = await testEmbeddings({}, trigger, ctx.db);
    const reported = part(probe, "output", "Vector");
    expect(reported.kind).toBe("vector");
    expect(reported.kind === "vector" && reported.dimensions).toBe(1024);
    // A preview, not 1024 numbers shipped to the browser and into the trace.
    expect(reported.kind === "vector" && reported.preview.length).toBe(8);
  });

  it("testAudio in chat mode probes through an input_audio completion", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Router",
      baseUrl: "https://router.example/v1",
      apiKey: "sk-router",
    });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(completion("hello there", "omni-model"));

    const probe = await testAudio(
      { model: "omni-model", transcriptionMode: "chat" },
      trigger,
      ctx.db,
    );
    expect(probe.model).toBe("omni-model");
    expect(partText(probe, "output", "Transcript")).toBe("hello there");
    expect(partText(probe, "input", "Mode")).toMatch(/input_audio/);
    // The audio actually sent is reported, not just described.
    expect(part(probe, "input", "Sent audio (generated silence)").kind).toBe("audio");

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    const [conn, input] = chatCompletionMock.mock.calls[0];
    expect(conn.baseUrl).toBe("https://router.example/v1");
    expect(input.model).toBe("omni-model");
    // The probe must exercise the same request shape the voice path sends.
    const user = input.messages.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    expect(
      (user?.content as Array<{ type: string }>).some((part) => part.type === "input_audio"),
    ).toBe(true);
  });

  it("testAudio without a model probes the chat-model input_audio fallback", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
    });
    // No audio model set: the probe must test the chat-model fallback, since
    // that is exactly what the voice path will use.
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(completion("", "gemma"));

    const probe = await testAudio({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    const [conn, input] = chatCompletionMock.mock.calls[0];
    expect(conn.baseUrl).toBe("https://llm.example/v1");
    expect(input.model).toBe("gemma");
    const user = input.messages.find((m) => m.role === "user");
    expect(
      (user?.content as Array<{ type: string }>).some((part) => part.type === "input_audio"),
    ).toBe(true);
  });

  it("testAudio rejects cleanly when nothing resolves", async () => {
    await expect(testAudio({}, trigger, ctx.db)).rejects.toThrow(/audio model/i);
  });

  it("testVision describes a generated image through the resolved runtime", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
    });
    // No vision model set: the probe must test the chat-model fallback, since
    // that is exactly what the describer will use.
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(completion("a red square", "gemma"));

    const probe = await testVision({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");
    expect(partText(probe, "output", "Description")).toBe("a red square");
    // The operator sees the same image the model was shown.
    expect(part(probe, "input", "Sent image").kind).toBe("image");

    const [, input] = chatCompletionMock.mock.calls[0];
    const user = input.messages.find((m) => m.role === "user");
    expect(
      (user?.content as Array<{ type: string }>).some((part) => part.type === "image_url"),
    ).toBe(true);
  });

  it("testVision rejects cleanly when nothing resolves", async () => {
    await expect(testVision({}, trigger, ctx.db)).rejects.toThrow(/vision model/i);
  });

  it("testBrowser runs a real tool round through the chat-model fallback", async () => {
    const chatId = await seedBackend(ctx, {
      name: "Main",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-chat",
    });
    // No browser model set: the probe must test the chat-model fallback, since
    // that is exactly what a browse job will use.
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    // Answer by invoking the offered tool, the way a tool-capable model does.
    chatCompletionWithToolsMock.mockImplementation(async (_conn, input) => {
      await input.callTool("probe_echo", { text: "ready" });
      return completion("ready", "gemma");
    });

    const probe = await testBrowser({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");
    expect(partText(probe, "output", "Tool call")).toMatch(/probe_echo was called/);
    expect(partText(probe, "output", "Answer")).toBe("ready");

    const [conn, input] = chatCompletionWithToolsMock.mock.calls[0];
    expect(conn.baseUrl).toBe("https://llm.example/v1");
    expect(input.model).toBe("gemma");
    // Tool support is the whole point of the probe, so one must be offered.
    expect(input.tools).toHaveLength(1);
  });

  it("testBrowser reports a model that answers without calling the tool", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    // No tool call: the connection works, the model just did not use the tool.
    chatCompletionWithToolsMock.mockResolvedValue(completion("ready", "gemma"));

    const probe = await testBrowser({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");
    expect(partText(probe, "output", "Tool call")).toMatch(/none/i);
  });

  it("testBrowser rejects cleanly when nothing resolves", async () => {
    await expect(testBrowser({}, trigger, ctx.db)).rejects.toThrow(/browser-agent model/i);
  });

  it("testClassifier runs the real addressing check and reports the parsed verdict", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    // No classifier model: the probe must exercise the chat-model fallback,
    // since that is what the reply path will classify with.
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    chatCompletionMock.mockResolvedValue(
      completion('{"name_match": "exact", "matched_text": "Zylbot"}', "gemma"),
    );

    const probe = await testClassifier({}, trigger, ctx.db);
    expect(probe.model).toBe("gemma");
    expect(partText(probe, "output", "Parsed verdict")).toMatch(/^addressed — cited "Zylbot"/);

    // The prompt must be the analyzer's real one, not a probe-only imitation:
    // that is what makes a pass mean the reply path will work.
    const [, input] = chatCompletionMock.mock.calls[0];
    expect(input.messages[0].content).toMatch(/name_match/);
    expect(input.messages.at(-1)?.content).toMatch(/Zylbot, can you check the schedule/);
    // Thinking off and a token cap — the shared classifier call bounds.
    expect(input.reasoning).toBe("off");
    expect(input.maxTokens).toBe(3_000);
  });

  it("testClassifier reports an unreadable verdict rather than passing it off", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    // Prose instead of JSON — the silent production failure this probe exists
    // to surface (an unreadable verdict reads as "not addressed").
    chatCompletionMock.mockResolvedValue(completion("Yes, they are talking to the bot.", "gemma"));

    const probe = await testClassifier({}, trigger, ctx.db);
    expect(partText(probe, "output", "Parsed verdict")).toMatch(
      /not addressed — unreadable analyzer answer/,
    );
    expect(partText(probe, "output", "Raw answer")).toBe("Yes, they are talking to the bot.");
  });

  it("testClassifier rejects cleanly when nothing resolves", async () => {
    await expect(testClassifier({}, trigger, ctx.db)).rejects.toThrow(/classifier model/i);
  });

  it("testBackground runs the real summarizer and reports the topics it parsed", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    const gpuId = await seedBackend(ctx, { name: "GPU", baseUrl: "https://gpu.example/v1" });
    await updateSettings(
      { chatBackendId: chatId, model: "gemma", backgroundBackendId: gpuId, backgroundModel: "qwen-long" },
      trigger,
      ctx.db,
    );
    chatCompletionMock.mockResolvedValue(
      completion(
        '{"topics": [{"content": "Ada and Bo debugged the staging deploy timeout.", "message_ids": [101, 102]}]}',
        "qwen-long",
      ),
    );

    const probe = await testBackground({}, trigger, ctx.db);
    expect(probe.model).toBe("qwen-long");
    expect(partText(probe, "output", "Topics parsed")).toBe(
      "1. Ada and Bo debugged the staging deploy timeout. [#101, #102]",
    );

    const [conn, input] = chatCompletionMock.mock.calls[0];
    // The role's own backend, not the chat one it could have inherited.
    expect(conn.baseUrl).toBe("https://gpu.example/v1");
    expect(input.model).toBe("qwen-long");
    // The real summarizer prompt over the real transcript format, at the
    // priority the nightly jobs run at.
    expect(input.messages[0].content).toMatch(/compress one day of chat history/i);
    expect(input.messages[1].content).toMatch(/\[#101\]/);
    expect(input.priority).toBe("background");
  });

  it("testBackground reports zero topics rather than calling prose a pass", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    // A fine paragraph and no JSON — which the nightly job would store as an
    // empty day, in silence.
    chatCompletionMock.mockResolvedValue(
      completion("They talked about a deploy and moved a meeting.", "gemma"),
    );

    const probe = await testBackground({}, trigger, ctx.db);
    expect(partText(probe, "output", "Topics parsed")).toMatch(/none/i);
    expect(partText(probe, "output", "Raw answer")).toMatch(/moved a meeting/);
  });

  it("testBackground rejects cleanly when nothing resolves", async () => {
    await expect(testBackground({}, trigger, ctx.db)).rejects.toThrow(/background model/i);
  });
});

describe("settings record round-trip", () => {
  it("keeps the raw settings record consistent with the client view", async () => {
    const chatId = await seedBackend(ctx, { name: "Main", baseUrl: "https://llm.example/v1" });
    await updateSettings({ chatBackendId: chatId, model: "gemma" }, trigger, ctx.db);
    const record = await getSettingsRecord(ctx.db);
    expect(record?.chatBackendId).toBe(chatId);
    expect(record?.model).toBe("gemma");
  });
});
