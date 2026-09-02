import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getMediaByMessage,
  insertMedia,
  markDescribed,
} from "@/features/vision/server/repository";
import {
  describeAndStore,
  getMediaSuffixesForMessages,
  type DescribeDeps,
} from "@/features/vision/server/service";
import {
  recordLlmRequest,
  recordLlmResponse,
  type ChatCompletionResult,
  type ChatMessage,
} from "@/server/llm/client";
import { getTraceDetail, listTraces, startTrace } from "@/server/trace";
import { seedSourceMessage, startTestStoreDb, type TestStoreDb } from "@/test/store-db";

/**
 * Voice messages ride the vision media pipeline (`message_media`, kind `voice`);
 * these tests exercise the transcription dispatch inside `describeAndStore`
 * against real Postgres. The transcode step runs the real system ffmpeg (already
 * a project requirement for video frames), fed a generated PCM WAV so no fixture
 * files are needed.
 */

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

/** A minimal valid 0.1s silent mono PCM WAV, as base64 (ffmpeg decodes it fine). */
function tinyWavBase64(): string {
  const sampleRate = 8000;
  const samples = 800;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf.toString("base64");
}

async function seedVoice(over?: { telegramMessageId?: number; dataBase64?: string }) {
  const telegramMessageId = over?.telegramMessageId ?? 70;
  // Media rows require their mirrored message (FK) — mirror first, like the pipeline.
  await seedSourceMessage(ctx, { chatId: "5", telegramMessageId });
  return insertMedia(ctx.db, {
    id: crypto.randomUUID(),
    chatId: "5",
    telegramMessageId,
    kind: "voice",
    fileId: "voice-70",
    fileUniqueId: "vu70",
    mimeType: "audio/ogg",
    dataBase64: over?.dataBase64 ?? tinyWavBase64(),
    visionHint: null,
  });
}

function fakeComplete(content: string): ChatCompletionResult {
  return {
    content,
    model: "audio-model",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 12,
    requestBody: {},
    responseBody: { id: "cmpl-1", choices: [{ message: { content } }] },
  };
}

describe("describeAndStore — voice dispatch", () => {
  it("transcribes a pending voice row via an input_audio turn and stores the transcript", async () => {
    await seedVoice();

    let seen: ChatMessage[] | null = null;
    let seenTrace: Parameters<DescribeDeps["complete"]>[1];
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 70 },
      {
        complete: async (messages, trace) => {
          seen = messages;
          seenTrace = trace;
          return fakeComplete("hello from the voice message");
        },
      },
      { db: ctx.db },
    );

    // The request was a transcription pass: strict system prompt + one audio part.
    const messages = seen! as ChatMessage[];
    expect(String(messages[0].content)).toContain("transcription engine");
    const parts = messages[1].content as Array<{
      type: string;
      input_audio?: { data: string; format: string };
    }>;
    const audio = parts.find((p) => p.type === "input_audio");
    expect(audio?.input_audio?.format).toBe("wav");
    expect((audio?.input_audio?.data.length ?? 0) > 0).toBe(true);

    // Transcript stored as the description; bytes dropped.
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("hello from the voice message");
    expect(result?.dataBase64).toBeNull();

    // History reads it exactly like other media annotations.
    const suffixes = await getMediaSuffixesForMessages("5", [70], ctx.db);
    expect(suffixes.get(70)).toBe(" [voice message: hello from the voice message]");

    // Traced under the voice feature, not vision.
    const voiceTraces = await listTraces({ feature: "voice" });
    expect(voiceTraces.traces[0]?.status).toBe("success");
    expect(voiceTraces.traces[0]?.action).toBe("transcribe");
    const visionTraces = await listTraces({ feature: "vision" });
    expect(visionTraces.traces).toHaveLength(0);

    // The call was handed the trace to record itself on (the shared LLM tracing
    // layer owns the request/response events — endpoint, model, redacted body;
    // see `server/llm/client.test.ts` for that contract).
    expect(seenTrace?.callKind).toBe("voice-transcribe");
    expect(seenTrace?.label).toBe("transcribe");
    expect(seenTrace?.recorder).toBeDefined();
  });

  it("prefers a wired dedicated STT endpoint over the chat model, with raw-body trace events", async () => {
    await seedVoice({ telegramMessageId: 75 });

    let completeCalled = false;
    let sttWav: Buffer | null = null;
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 75 },
      {
        complete: async () => {
          completeCalled = true;
          return fakeComplete("unused — the STT path must win");
        },
        transcribe: async (wav) => {
          sttWav = wav;
          return {
            text: "spoken via whisper",
            latencyMs: 20,
            responseBody: { text: "spoken via whisper" },
          };
        },
        transcribeTarget: { baseUrl: "https://whisper.example.com/v1", model: "large-v3" },
      },
      { db: ctx.db },
    );

    expect(completeCalled).toBe(false);
    expect((sttWav as Buffer | null)?.length ?? 0).toBeGreaterThan(0);
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("spoken via whisper");

    const traces = await listTraces({ feature: "voice" });
    const detail = await getTraceDetail(traces.traces[0]!.id);
    const request = detail?.events.find((e) => e.message === "transcription request");
    expect(request?.data).toMatchObject({
      endpoint: "https://whisper.example.com/v1",
      model: "large-v3",
    });
    const response = detail?.events.find((e) => e.message === "transcription response");
    expect(response?.data).toEqual({ text: "spoken via whisper" });
  });

  it("stores '(no speech)' terminally so the backfill never loops on silent audio", async () => {
    await seedVoice({ telegramMessageId: 71 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 71 },
      { complete: async () => fakeComplete("[no speech]") },
      { db: ctx.db },
    );
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("(no speech)");
  });

  it("fails instead of storing a blank transcript when the chat model returns nothing", async () => {
    await seedVoice({ telegramMessageId: 72 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 72 },
      { complete: async () => fakeComplete("   \n ") },
      { db: ctx.db },
    );

    expect(result).toBeNull();
    const media = await getMediaByMessage(ctx.db, "5", 72);
    expect(media?.status).toBe("pending");
    expect(media?.description).toBeNull();

    const traces = await listTraces({ feature: "voice" });
    expect(traces.traces[0]?.status).toBe("error");
  });

  it("fails a dedicated STT endpoint that answers with no text, keeping the audio retryable", async () => {
    await seedVoice({ telegramMessageId: 73 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 73 },
      {
        complete: async () => fakeComplete("unused — the STT path must win"),
        // What a whisper-class server does on an internal failure it reports as 200.
        transcribe: async () => ({ text: "", latencyMs: 8, responseBody: { text: "" } }),
        transcribeTarget: { baseUrl: "https://whisper.example.com/v1", model: "large-v3" },
      },
      { db: ctx.db },
    );

    expect(result).toBeNull();
    const media = await getMediaByMessage(ctx.db, "5", 73);
    expect(media?.status).toBe("pending");
    expect(media?.description).toBeNull();
    // The bytes must survive, or "retryable" is a word with nothing behind it.
    expect(media?.dataBase64).toBeTruthy();

    const traces = await listTraces({ feature: "voice" });
    expect(traces.traces[0]?.status).toBe("error");
  });

  it("records into a passed parent trace instead of opening its own (live reply path)", async () => {
    await seedVoice({ telegramMessageId: 74 });
    const before = (await listTraces({ feature: "voice" })).traces.length;

    const parent = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "transport", actor: "5", correlationId: "5:74" },
    });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 74 },
      {
        // Record like the real completion does (the shared LLM tracing layer),
        // so the parent-trace assertion pins the same titles production writes.
        complete: async (messages, trace) => {
          await recordLlmRequest({ baseUrl: "https://llm.test/v1" }, trace, {
            model: "omni-audio",
            messages,
          });
          const completed = fakeComplete("nested transcript");
          await recordLlmResponse(trace, {
            model: completed.model,
            latencyMs: completed.latencyMs,
            responseBody: completed.responseBody,
            content: completed.content,
          });
          return completed;
        },
      },
      { db: ctx.db, trace: parent },
    );
    await parent.succeed({ outputSummary: "done" });

    expect(result?.description).toBe("nested transcript");
    // No standalone voice trace was opened — the transcription events belong to
    // the reply trace: one trace per handled message.
    expect((await listTraces({ feature: "voice" })).traces).toHaveLength(before);
    const detail = await getTraceDetail(parent.id);
    const messages = detail?.events.map((e) => e.message) ?? [];
    expect(messages).toContain("transcribe request");
    expect(messages).toContain("transcribe response");
    expect(messages).toContain("voice message transcribed");
  });

  it("returns the winner's transcript — never a failure — when a concurrent pass wins the write race", async () => {
    const seeded = await seedVoice({ telegramMessageId: 76 });

    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 76 },
      {
        complete: async () => {
          // A concurrent pass describes the row while our LLM call is in flight,
          // so this pass's markDescribed will match nothing.
          await markDescribed(ctx.db, seeded!.id, "the winner's transcript");
          return fakeComplete("the loser's transcript");
        },
      },
      { db: ctx.db },
    );

    // The caller still gets a described record with real text (the winner's) —
    // this exact race used to surface as "voice message could not be transcribed"
    // while a transcript sat in the DB.
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("the winner's transcript");
    const traces = await listTraces({ feature: "voice" });
    expect(traces.traces[0]?.status).toBe("success");
  });

  it("reuses an already-stored transcript without spending a call (re-delivered update)", async () => {
    const seeded = await seedVoice({ telegramMessageId: 77 });
    await markDescribed(ctx.db, seeded!.id, "already transcribed");

    let called = false;
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 77 },
      {
        complete: async () => {
          called = true;
          return fakeComplete("unused");
        },
      },
      { db: ctx.db },
    );

    expect(called).toBe(false);
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("already transcribed");
  });

  it("leaves the row pending (for the backfill retry) when the audio cannot be transcoded", async () => {
    // Garbage bytes: ffmpeg cannot decode them, the transcode throws, the trace fails.
    await seedVoice({ telegramMessageId: 72, dataBase64: Buffer.from("junk").toString("base64") });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 72 },
      { complete: async () => fakeComplete("unused") },
      { db: ctx.db },
    );
    expect(result).toBeNull();
    const row = await getMediaByMessage(ctx.db, "5", 72);
    expect(row?.status).toBe("pending");
    const traces = await listTraces({ feature: "voice" });
    expect(traces.traces[0]?.status).toBe("error");
  });
});
