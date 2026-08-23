import { fileURLToPath } from "node:url";

import {
  internalDeleteMessageResponseSchema,
  internalReactionResponseSchema,
  internalSentFileResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import { getMediaByMessage } from "./media/store";
import type { TgOutbound } from "./outbound";
import { appendMessage, getMessageByTelegramId } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

/** A supergroup id with a `-100` prefix, so `#<id>` links have a base URL. */
const CHAT_ID = "-1001234567890";
const TOKEN = "secret-token";
const HEADERS = { "x-internal-token": TOKEN, "content-type": "application/json" };

/** Minted message ids — shared across fakes, since the mirror is one table. */
let nextId = 500;

/** A recording fake of the outbound ops; each test overrides what it exercises. */
function fakeSender(overrides?: Partial<TgOutbound>): {
  sender: TgOutbound;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    sendMessage: [],
    sendVoice: [],
    sendPhoto: [],
    sendFile: [],
    deleteMessage: [],
    setReaction: [],
  };
  const sender: TgOutbound = {
    async sendMessage(chatId, text, opts) {
      calls.sendMessage.push({ chatId, text, opts });
      return { messageId: ++nextId };
    },
    async sendVoice(chatId, voice, opts) {
      calls.sendVoice.push({ chatId, voice, opts });
      return { messageId: ++nextId };
    },
    async sendPhoto(chatId, image, opts) {
      calls.sendPhoto.push({ chatId, image, opts });
      return { messageId: ++nextId, fileId: `file-${nextId}`, fileUniqueId: `u-${nextId}` };
    },
    async sendFile(chatId, file, opts) {
      calls.sendFile.push({ chatId, filename: file.filename, mime: file.mime, opts });
      return { messageId: ++nextId };
    },
    async deleteMessage(chatId, messageId) {
      calls.deleteMessage.push({ chatId, messageId });
    },
    async setReaction(chatId, messageId, emoji, opts) {
      calls.setReaction.push({ chatId, messageId, emoji, opts });
    },
    sendTyping: () => undefined,
    ...overrides,
  };
  return { sender, calls };
}

describe("tg outbound API", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_outbound");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });

    // Prior conversation: a mirrored human message (#21) and one of the
    // bot's own replies (#22) — the reaction and link checks read these.
    await appendMessage(db, {
      chatId: CHAT_ID,
      telegramMessageId: 21,
      role: "user",
      userId: "5001",
      content: "the earlier question",
      replyToMessageId: null,
      sentAt: new Date(),
      processed: true,
    });
    await appendMessage(db, {
      chatId: CHAT_ID,
      telegramMessageId: 22,
      role: "assistant",
      userId: null,
      content: "the earlier answer",
      replyToMessageId: 21,
      sentAt: new Date(),
      processed: true,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  function api(sender: TgOutbound) {
    return createApi({
      db,
      manager: {
        statuses: () => [],
        senderFor: () => sender,
        reconcileConnection: async () => undefined,
        removeConnection: async () => undefined,
      },
      internalToken: TOKEN,
    });
  }

  it("refuses without the internal token", async () => {
    const { sender } = fakeSender();
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("sends a text message with mirror-checked citation links and mirrors it", async () => {
    const { sender, calls } = fakeSender();
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        text: "see #21 and #99",
        replyToSourceMessageId: "21",
        silent: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = internalSentMessageResponseSchema.parse(await res.json());

    // Only the mirrored citation is whitelisted; the invented #99 stays text.
    expect(calls.sendMessage[0]).toMatchObject({
      chatId: CHAT_ID,
      text: "see #21 and #99",
      opts: { replyToMessageId: 21, silent: true, linkableMessageIds: [21] },
    });
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, Number(body.sourceMessageId));
    expect(mirrored).toMatchObject({
      role: "assistant",
      content: "see #21 and #99",
      replyToMessageId: 21,
      processed: true,
    });
  });

  it("relays a send failure as 502 instead of mirroring a message that never left", async () => {
    const { sender } = fakeSender({
      sendMessage: async () => {
        throw new Error("No running telegram connection");
      },
    });
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("No running telegram connection");
  });

  it("delivers a voice bubble and mirrors the spoken text", async () => {
    const { sender, calls } = fakeSender();
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/voice`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        audioBase64: Buffer.from("fake-ogg").toString("base64"),
        text: "the spoken answer",
        replyToSourceMessageId: "21",
      }),
    });
    const body = internalSentVoiceResponseSchema.parse(await res.json());
    expect(body.asVoice).toBe(true);
    expect(calls.sendVoice).toHaveLength(1);
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, Number(body.sourceMessageId));
    expect(mirrored).toMatchObject({ role: "assistant", content: "the spoken answer" });
  });

  it("falls back to a text send when the voice bubble is refused", async () => {
    const { sender, calls } = fakeSender({
      sendVoice: async () => {
        throw new Error("VOICE_MESSAGES_FORBIDDEN");
      },
    });
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/voice`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        audioBase64: Buffer.from("fake-ogg").toString("base64"),
        text: "the spoken answer, in writing",
      }),
    });
    const body = internalSentVoiceResponseSchema.parse(await res.json());
    expect(body.asVoice).toBe(false);
    expect(calls.sendMessage).toHaveLength(1);
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, Number(body.sourceMessageId));
    expect(mirrored).toMatchObject({ role: "assistant", content: "the spoken answer, in writing" });
  });

  it("delivers generated images as the mirror-row + pending-media pair", async () => {
    const png = await sharp({
      create: { width: 24, height: 16, channels: 3, background: { r: 40, g: 40, b: 200 } },
    })
      .png()
      .toBuffer();
    const { sender, calls } = fakeSender();
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/photos`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ images: [png.toString("base64")] }),
    });
    const body = internalSentPhotosResponseSchema.parse(await res.json());
    expect(body.delivered).toHaveLength(1);
    expect(body.delivered[0].stored).toBe(true);
    expect(calls.sendPhoto).toHaveLength(1);

    const messageId = Number(body.delivered[0].sourceMessageId);
    // The picture IS the message: a media-only assistant row…
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, messageId);
    expect(mirrored).toMatchObject({ role: "assistant", content: "" });
    // …and a pending media row keyed by the file id Telegram minted,
    // normalized like any user-sent picture, hinted as the bot's own work.
    const media = await getMediaByMessage(db, CHAT_ID, messageId);
    expect(media).toMatchObject({ kind: "photo", status: "pending", mimeType: "image/jpeg" });
    expect(media!.fileId).toBe(`file-${messageId}`);
    expect(media!.visionHint).toContain("generated by the bot itself");
    const bytes = Buffer.from(media!.frames[0], "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it("delivers a file with its caption mirrored as the message content", async () => {
    const { sender, calls } = fakeSender();
    const res = await api(sender).request(`/internal/chats/${CHAT_ID}/files`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        dataBase64: Buffer.from("fake-mp4").toString("base64"),
        filename: "clip.mp4",
        mime: "video/mp4",
        caption: "the run report",
      }),
    });
    expect(res.status).toBe(200);
    const body = internalSentFileResponseSchema.parse(await res.json());
    expect(calls.sendFile[0]).toMatchObject({
      chatId: CHAT_ID,
      filename: "clip.mp4",
      mime: "video/mp4",
      opts: { caption: "the run report" },
    });
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, Number(body.sourceMessageId));
    expect(mirrored).toMatchObject({ role: "assistant", content: "the run report" });
  });

  it("deletes a message and soft-deletes its mirror row; a refusal is cosmetic", async () => {
    await appendMessage(db, {
      chatId: CHAT_ID,
      telegramMessageId: 40,
      role: "assistant",
      userId: null,
      content: "on it",
      replyToMessageId: null,
      sentAt: new Date(),
      processed: true,
    });
    const { sender, calls } = fakeSender();
    const ok = await api(sender).request(`/internal/chats/${CHAT_ID}/messages/40`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(internalDeleteMessageResponseSchema.parse(await ok.json())).toEqual({ deleted: true });
    expect(calls.deleteMessage[0]).toEqual({ chatId: CHAT_ID, messageId: 40 });
    const row = await getMessageByTelegramId(db, CHAT_ID, 40);
    expect(row!.deletedAt).not.toBeNull();

    const { sender: refusing } = fakeSender({
      deleteMessage: async () => {
        throw new Error("message can't be deleted");
      },
    });
    const refused = await api(refusing).request(`/internal/chats/${CHAT_ID}/messages/21`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(internalDeleteMessageResponseSchema.parse(await refused.json())).toEqual({
      deleted: false,
    });
    const kept = await getMessageByTelegramId(db, CHAT_ID, 21);
    expect(kept!.deletedAt).toBeNull();
  });

  it("gates reactions on the mirror and records the accepted one", async () => {
    const { sender, calls } = fakeSender();
    const app = api(sender);

    // An id the model guessed: refused without touching the platform.
    const missing = await app.request(`/internal/chats/${CHAT_ID}/messages/9999/reaction`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(internalReactionResponseSchema.parse(await missing.json()).status).toBe("not_found");

    // The bot's own message: never a valid target.
    const own = await app.request(`/internal/chats/${CHAT_ID}/messages/22/reaction`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(internalReactionResponseSchema.parse(await own.json()).status).toBe("own_message");
    expect(calls.setReaction).toHaveLength(0);

    // A person's message: reacted and remembered on the mirror row.
    const ok = await app.request(`/internal/chats/${CHAT_ID}/messages/21/reaction`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ emoji: "👍", big: true }),
    });
    expect(internalReactionResponseSchema.parse(await ok.json())).toEqual({
      status: "ok",
      recorded: true,
    });
    expect(calls.setReaction[0]).toMatchObject({ messageId: 21, emoji: "👍", opts: { big: true } });
    const row = await getMessageByTelegramId(db, CHAT_ID, 21);
    expect(row!.botReaction).toBe("👍");

    // A platform refusal is relayed verbatim for the tool to word.
    const { sender: refusing } = fakeSender({
      setReaction: async () => {
        throw new Error("REACTION_INVALID");
      },
    });
    const refused = await api(refusing).request(`/internal/chats/${CHAT_ID}/messages/21/reaction`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ emoji: "🕊" }),
    });
    expect(refused.status).toBe(502);
    const body = (await refused.json()) as { error: { message: string } };
    expect(body.error.message).toContain("REACTION_INVALID");
  });
});
