import { fileURLToPath } from "node:url";

import {
  inboundMessageEventSchema,
  internalMediaDescribeResponseSchema,
  internalMediaResponseSchema,
  internalPendingMediaResponseSchema,
  internalRecentMediaResponseSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import type { Message } from "@grammyjs/types";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../store/schema";
import { createApi } from "../api";
import { processIncomingMessage } from "../inbound";
import type { FileDownloader } from "./ingest";
import { getMediaByMessage } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/** A real (tiny) PNG so the sharp normalization path runs for real. */
async function fixturePngBase64(): Promise<string> {
  const png = await sharp({
    create: { width: 24, height: 16, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function photoMessage(input: { messageId: number; caption?: string }): Message {
  return {
    message_id: input.messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 5001, type: "private", first_name: "Peer" },
    from: { id: 5001, is_bot: false, first_name: "Alice", username: "alice_example" },
    caption: input.caption,
    photo: [
      { file_id: "photo-small", file_unique_id: "u1", width: 24, height: 16 },
      { file_id: "photo-large", file_unique_id: "u2", width: 240, height: 160 },
    ],
  } as Message;
}

function voiceMessage(input: { messageId: number }): Message {
  return {
    message_id: input.messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 5001, type: "private", first_name: "Peer" },
    from: { id: 5001, is_bot: false, first_name: "Alice", username: "alice_example" },
    voice: { file_id: "voice-1", file_unique_id: "uv1", duration: 3 },
  } as Message;
}

describe("tg media", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let pngBase64: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_media");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    pngBase64 = await fixturePngBase64();
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  function deps(input: {
    enqueued: InboundMessageEvent[];
    download: FileDownloader;
  }) {
    return {
      db,
      assistantId: "assistant-1",
      identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
      botId: 999,
      botToken: "12345:fixture-token",
      enqueue: async (event: InboundMessageEvent) => {
        input.enqueued.push(event);
      },
      download: input.download,
    };
  }

  it("ingests a photo (normalized to JPEG) and the event carries the pending media", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const result = await processIncomingMessage(
      photoMessage({ messageId: 31, caption: "look at this" }),
      deps({
        enqueued,
        download: async (_token, fileId) => {
          // The largest rendition is the one read (v1 `detectMessageMedia`).
          expect(fileId).toBe("photo-large");
          return { base64: pngBase64, mimeHint: "image/png" };
        },
      }),
    );
    expect(result.status).toBe("enqueued");
    const event = inboundMessageEventSchema.parse(enqueued[0]);
    expect(event.message.media).toHaveLength(1);
    expect(event.message.media[0]).toMatchObject({ kind: "photo", status: "pending", description: null });

    const stored = await getMediaByMessage(db, "5001", 31);
    expect(stored).toMatchObject({ kind: "photo", status: "pending", mimeType: "image/jpeg" });
    // Normalization re-encoded the PNG as a real JPEG payload.
    expect(stored!.frames).toHaveLength(1);
    const bytes = Buffer.from(stored!.frames[0], "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it("a caption-less media message is a real turn; failed downloads store an unavailable marker", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const result = await processIncomingMessage(
      photoMessage({ messageId: 32 }),
      deps({ enqueued, download: async () => null }),
    );
    // Mirrored with empty content and enqueued — the core decides the turn.
    expect(result.status).toBe("enqueued");
    const event = inboundMessageEventSchema.parse(enqueued[0]);
    expect(event.message.content).toBe("");
    expect(event.message.media[0]).toMatchObject({ kind: "photo", status: "unavailable" });
  });

  it("stores a voice message's raw audio for the core to transcribe", async () => {
    const enqueued: InboundMessageEvent[] = [];
    await processIncomingMessage(
      voiceMessage({ messageId: 33 }),
      deps({
        enqueued,
        download: async () => ({
          base64: Buffer.from("fake-ogg-bytes").toString("base64"),
          mimeHint: "audio/ogg",
        }),
      }),
    );
    const stored = await getMediaByMessage(db, "5001", 33);
    expect(stored).toMatchObject({ kind: "voice", status: "pending", mimeType: "audio/ogg" });
    expect(Buffer.from(stored!.frames[0], "base64").toString()).toBe("fake-ogg-bytes");
  });

  it("serves and describes media over the internal API (describe-then-drop)", async () => {
    const api = createApi({
      db,
      manager: {
        statuses: () => [],
        senderFor: () => {
          throw new Error("no connection in this test");
        },
        reconcileConnection: async () => undefined,
        removeConnection: async () => undefined,
      },
      internalToken: "secret-token",
    });
    const headers = { "x-internal-token": "secret-token" };

    // Auth is enforced.
    const denied = await api.request("/internal/chats/5001/messages/31/media");
    expect(denied.status).toBe(401);

    // The pending row serves its bytes.
    const res = await api.request("/internal/chats/5001/messages/31/media", { headers });
    expect(res.status).toBe(200);
    const body = internalMediaResponseSchema.parse(await res.json());
    expect(body.media).toMatchObject({ kind: "photo", status: "pending", sourceMessageId: "31" });
    expect(body.media!.frames).toHaveLength(1);

    // The core writes the description back; the bytes are dropped.
    const put = await api.request(`/internal/media/${body.media!.id}/description`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ description: "a red rectangle" }),
    });
    expect(put.status).toBe(200);
    const described = internalMediaDescribeResponseSchema.parse(await put.json());
    expect(described.updated).toBe(true);
    expect(described.media).toMatchObject({
      status: "described",
      description: "a red rectangle",
      frames: [],
    });
    const blobs = await pool.query(`SELECT count(*) AS count FROM media_blobs WHERE media_id = $1`, [
      body.media!.id,
    ]);
    expect(Number(blobs.rows[0].count)).toBe(0);

    // A second describe is the concurrent-winner path: not updated, stored text served.
    const again = await api.request(`/internal/media/${body.media!.id}/description`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ description: "something else" }),
    });
    const winner = internalMediaDescribeResponseSchema.parse(await again.json());
    expect(winner.updated).toBe(false);
    expect(winner.media).toMatchObject({ description: "a red rectangle" });

    // An unknown message has no media.
    const missing = await api.request("/internal/chats/5001/messages/999/media", { headers });
    expect(internalMediaResponseSchema.parse(await missing.json()).media).toBeNull();
  });

  it("serves the backfill work list and the recent gallery", async () => {
    const api = createApi({
      db,
      manager: {
        statuses: () => [],
        senderFor: () => {
          throw new Error("no connection in this test");
        },
        reconcileConnection: async () => undefined,
        removeConnection: async () => undefined,
      },
      internalToken: "secret-token",
    });
    const headers = { "x-internal-token": "secret-token" };

    // The rows accumulated above: at least the voice row is still pending
    // and its message is not live-held (holds released by the tests' flow).
    await pool.query(`UPDATE messages SET processed = true`);
    const pending = internalPendingMediaResponseSchema.parse(
      await (await api.request("/internal/media/pending?limit=10", { headers })).json(),
    );
    expect(pending.total).toBeGreaterThan(0);
    expect(pending.media.length).toBeGreaterThan(0);
    // Byte-free refs only.
    expect(Object.keys(pending.media[0]).sort()).toEqual(["chatId", "id", "sourceMessageId"]);

    // A live-held message parks its media out of the work list, but not the count.
    await pool.query(`UPDATE messages SET processed = false`);
    const held = internalPendingMediaResponseSchema.parse(
      await (await api.request("/internal/media/pending?limit=10", { headers })).json(),
    );
    expect(held.media).toHaveLength(0);
    expect(held.total).toBe(pending.total);
    await pool.query(`UPDATE messages SET processed = true`);

    const recent = internalRecentMediaResponseSchema.parse(
      await (await api.request("/internal/media/recent?limit=50", { headers })).json(),
    );
    expect(recent.media.length).toBeGreaterThan(0);
    // Pending rows carry frames for the gallery; described rows are byte-free.
    for (const row of recent.media) {
      if (row.status === "described") expect(row.frames).toEqual([]);
    }
    expect(recent.media.some((row) => row.status === "pending" && row.frames.length > 0)).toBe(
      true,
    );
  });
});
