import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mediaBlobs } from "@/db/schema";
import type { ChatCompletionResult } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { seedMirrorMessage, startTestDb, type TestDb } from "@/test/db";

import {
  getMediaAnnotations,
  getMediaByMessage,
  insertMedia,
  insertUnavailableMedia,
  listPendingMedia,
  listRecentMedia,
  markDescribed,
} from "./repository";
import {
  describeAndStore,
  getMediaAnnotationsForMessages,
  getMediaSuffixesForMessages,
} from "./service";

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

async function seedPending(over?: { chatId?: string; telegramMessageId?: number }) {
  const chatId = over?.chatId ?? "5";
  const telegramMessageId = over?.telegramMessageId ?? 10;
  // Media rows require their mirrored message (FK) — mirror first, like the pipeline.
  await seedMirrorMessage(ctx.db, { chatId, telegramMessageId });
  return insertMedia(ctx.db, {
    id: crypto.randomUUID(),
    chatId,
    telegramMessageId,
    kind: "photo",
    fileId: "file-1",
    fileUniqueId: "u1",
    mimeType: "image/jpeg",
    dataBase64: "QUJD",
    visionHint: null,
  });
}

function fakeComplete(content: string): ChatCompletionResult {
  return {
    content,
    model: "vision-model",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 12,
    requestBody: {},
    responseBody: {},
  };
}

describe("message_media repository", () => {
  it("inserts a pending row idempotently on (chat, message)", async () => {
    const first = await seedPending();
    expect(first?.status).toBe("pending");
    const second = await seedPending();
    expect(second).toBeNull(); // conflict → no duplicate
    expect(await listRecentMedia(ctx.db)).toHaveLength(1);
  });

  it("records an unavailable placeholder with no bytes", async () => {
    await seedMirrorMessage(ctx.db, { chatId: "5", telegramMessageId: 11 });
    const row = await insertUnavailableMedia(ctx.db, {
      id: crypto.randomUUID(),
      chatId: "5",
      telegramMessageId: 11,
      kind: "sticker",
      fileId: "f",
      fileUniqueId: null,
      visionHint: "Sticker emoji: 😀",
    });
    expect(row?.status).toBe("unavailable");
    expect(row?.dataBase64).toBeNull();
  });

  it("markDescribed stores the description, drops bytes, and won't re-describe", async () => {
    const pending = await seedPending();
    const described = await markDescribed(ctx.db, pending!.id, "a red car");
    expect(described?.status).toBe("described");
    expect(described?.description).toBe("a red car");
    expect(described?.dataBase64).toBeNull();
    expect(described?.describedAt).not.toBeNull();
    // The bytes are physically gone, not just hidden: no blob rows remain.
    const blobs = await ctx.db.select().from(mediaBlobs).where(eq(mediaBlobs.mediaId, pending!.id));
    expect(blobs).toHaveLength(0);
    // A second describe is a no-op (row no longer pending).
    expect(await markDescribed(ctx.db, pending!.id, "different")).toBeNull();
  });

  it("stores a video's frames as ordered blob rows and reads them back in order", async () => {
    const frames = ["frame-one", "frame-two", "frame-three"].map((text) =>
      Buffer.from(text).toString("base64"),
    );
    await seedMirrorMessage(ctx.db, { chatId: "5", telegramMessageId: 50 });
    await insertMedia(ctx.db, {
      id: crypto.randomUUID(),
      chatId: "5",
      telegramMessageId: 50,
      kind: "video",
      fileId: "vid-50",
      fileUniqueId: "vu50",
      mimeType: "image/jpeg",
      dataBase64: frames[0],
      frames,
      visionHint: null,
    });

    // One bytea row per frame, indexed in chronological order.
    const blobs = await ctx.db.select().from(mediaBlobs).orderBy(asc(mediaBlobs.frameIndex));
    expect(blobs.map((b) => b.frameIndex)).toEqual([0, 1, 2]);
    expect(blobs.map((b) => b.data.toString())).toEqual(["frame-one", "frame-two", "frame-three"]);

    // Reading the row back reassembles the same base64 sequence, first frame as preview.
    const record = await getMediaByMessage(ctx.db, "5", 50);
    expect(record?.frames).toEqual(frames);
    expect(record?.dataBase64).toBe(frames[0]);
  });

  it("lists bytes only for pending rows, and the backfill scan is byte-free", async () => {
    const described = await seedPending({ telegramMessageId: 60 });
    await markDescribed(ctx.db, described!.id, "a cat");
    await seedPending({ telegramMessageId: 61 });

    const list = await listRecentMedia(ctx.db);
    const byMessage = new Map(list.map((r) => [r.telegramMessageId, r]));
    expect(byMessage.get(61)?.dataBase64).toBe("QUJD");
    expect(byMessage.get(60)?.dataBase64).toBeNull();

    // The backfill batch carries references only — never payloads.
    const pending = await listPendingMedia(ctx.db);
    expect(pending).toEqual([
      { id: byMessage.get(61)!.id, chatId: "5", telegramMessageId: 61 },
    ]);
  });

  it("returns media annotations keyed by telegram message id", async () => {
    const pending = await seedPending({ telegramMessageId: 20 });
    await markDescribed(ctx.db, pending!.id, "a cat");
    await seedPending({ telegramMessageId: 21 });
    const annotations = await getMediaAnnotations(ctx.db, "5", [20, 21, 99]);
    expect(annotations.get(20)).toEqual({ kind: "photo", status: "described", description: "a cat" });
    expect(annotations.get(21)).toEqual({ kind: "photo", status: "pending", description: null });
    expect(annotations.has(99)).toBe(false);
  });

  it("renders media suffixes for the /history + transcript display", async () => {
    const described = await seedPending({ telegramMessageId: 22 });
    await markDescribed(ctx.db, described!.id, "a red car");
    await seedPending({ telegramMessageId: 23 }); // still pending

    const suffixes = await getMediaSuffixesForMessages("5", [22, 23, 99], ctx.db);
    expect(suffixes.get(22)).toBe(" [photo: a red car]"); // described → shows the recognition
    expect(suffixes.get(23)).toBe(" [photo]"); // pending → bare marker, never blank
    expect(suffixes.has(99)).toBe(false);
  });
});

describe("describeAndStore", () => {
  it("describes pending media, drops the bytes, and records a success trace", async () => {
    await seedPending({ telegramMessageId: 30 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 30 },
      { complete: async () => fakeComplete("a red car on a street") },
      { db: ctx.db },
    );
    expect(result?.status).toBe("described");
    expect(result?.description).toBe("a red car on a street");

    const annotations = await getMediaAnnotationsForMessages("5", [30], ctx.db);
    expect(annotations.get(30)?.description).toBe("a red car on a street");

    const traces = await listTraces({ feature: "vision" });
    expect(traces.traces[0]?.status).toBe("success");
  });

  it("describes a video from its ordered frame sequence, then drops all frames", async () => {
    await seedMirrorMessage(ctx.db, { chatId: "5", telegramMessageId: 40 });
    await insertMedia(ctx.db, {
      id: crypto.randomUUID(),
      chatId: "5",
      telegramMessageId: 40,
      kind: "video",
      fileId: "vid-40",
      fileUniqueId: "vu40",
      mimeType: "image/jpeg",
      dataBase64: "F1", // first frame, for the dashboard preview
      frames: ["F1", "F2", "F3"],
      visionHint: "The next 3 images are consecutive frames from the user's video…",
    });

    let seen: unknown = null;
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 40 },
      {
        complete: async (messages) => {
          seen = messages;
          return fakeComplete("a man lighting his beard on fire across the clip");
        },
      },
      { db: ctx.db },
    );

    // The describe request carried all three frames as separate, ordered images.
    const messages = seen as Array<{ role: string; content: unknown }>;
    const userTurn = messages.find((m) => m.role === "user");
    const parts = userTurn?.content as Array<{ type: string; text?: string }>;
    const imageParts = parts.filter((p) => p.type === "image_url");
    expect(imageParts).toHaveLength(3);
    expect(parts.some((p) => p.type === "text" && p.text === "Frame 1 of 3:")).toBe(true);

    // Bytes dropped on success: no single frame and no frame array remain.
    expect(result?.status).toBe("described");
    expect(result?.dataBase64).toBeNull();
    expect(result?.frames).toBeNull();
  });

  it("skips (no throw) when there is no pending media", async () => {
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 999 },
      { complete: async () => fakeComplete("unused") },
      { db: ctx.db },
    );
    expect(result).toBeNull();
    const traces = await listTraces({ feature: "vision" });
    expect(traces.traces[0]?.status).toBe("skipped");
  });

  it("leaves the row pending and fails the trace when the model errors", async () => {
    await seedPending({ telegramMessageId: 31 });
    const result = await describeAndStore(
      { chatId: "5", telegramMessageId: 31 },
      {
        complete: async () => {
          throw new Error("provider down");
        },
      },
      { db: ctx.db },
    );
    expect(result).toBeNull();
    const annotations = await getMediaAnnotationsForMessages("5", [31], ctx.db);
    expect(annotations.get(31)?.status).toBe("pending");
    const traces = await listTraces({ feature: "vision" });
    expect(traces.traces[0]?.status).toBe("error");
  });
});
