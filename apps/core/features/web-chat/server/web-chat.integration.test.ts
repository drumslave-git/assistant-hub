import { fileURLToPath } from "node:url";

import type { InboundMessageEvent, ReplyDeliveryEvent } from "@assistant-hub-swarm/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub-swarm/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoreDb } from "@/server/store/db";

import * as storeSchema from "../../../store/schema";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * The web chat as a core feature (Phase 6 — the chat app dissolved): a human
 * posts into a thread, one normalized inbound event reaches the enqueue seam,
 * and the pipeline's reply-delivery event lands in the transcript through the
 * in-process delivery handler. Ported from the chat app's runtime suite; the
 * HTTP surface it exercised is gone, so the same behaviors are proven against
 * the service, the outbound port, and the delivery handler directly.
 */

const ASSISTANT_ID = "assistant-fixture";

/** What postChatMessage enqueued, captured at the queue seam. */
const { enqueued, holder } = vi.hoisted(() => ({
  enqueued: [] as InboundMessageEvent[],
  holder: { db: null as unknown },
}));

vi.mock("@/server/turn/enqueue", () => ({
  enqueueInboundEvent: async (event: InboundMessageEvent) => {
    enqueued.push(event);
  },
}));

// The feature's modules read the process store handle by default; point it at
// the suite's container so the env-bound halves (delivery handler, outbound
// port, directory client, MCP tools) run against the same database.
vi.mock("@/server/store/db", () => ({
  getStoreDb: () => holder.db,
  getStorePool: () => {
    throw new Error("not used in this suite");
  },
  closeStorePool: async () => {},
}));

// The service's default db handle reads env at call time; every call in this
// suite passes the container-backed db explicitly instead.
const service = await import("./service");
const outboundModule = await import("./outbound");
const deliveryModule = await import("./delivery");
const repository = await import("./repository");
const mediaRepository = await import("./media-repository");
const { webChatDirectoryClient } = await import("./directory");
const { webChatToolOffered, CHAT_REPLY_TOOL, CHAT_SEND_TOOL } = await import("./mcp-tools");

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("web_chat");
  await applyMigrations(url, STORE_MIGRATIONS);
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema: storeSchema });
  holder.db = db;
});

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

/** The acting account — the web user IS the account since Phase 8. */
const ACCOUNT_ID = "account-fixture";

beforeEach(async () => {
  enqueued.length = 0;
  await pool.query(`TRUNCATE accounts, web_threads, web_messages RESTART IDENTITY CASCADE`);
  // Admin, so the owner-rights judgement grants the sender (as the single
  // operator's did before accounts).
  await pool.query(
    `INSERT INTO accounts (id, username, display_name, password_hash, role, session_secret)
     VALUES ($1, 'operator', 'Operator', 'scrypt:x', 'admin', 's')`,
    [ACCOUNT_ID],
  );
});

describe("web-chat store", () => {
  it("enforces its shape and cascades from the account down", async () => {
    await pool.query(
      `INSERT INTO web_threads (id, user_id, assistant_id, name)
       VALUES ('thread-1', $1, 'assistant-1', 'First thread')`,
      [ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO web_messages (thread_id, role, content, sent_at)
       VALUES ('thread-1', 'user', 'hello', now())`,
    );

    // Role is constrained.
    await expect(
      pool.query(
        `INSERT INTO web_messages (thread_id, role, content, sent_at)
         VALUES ('thread-1', 'system', 'nope', now())`,
      ),
    ).rejects.toThrow(/web_messages_role_check/);

    // Deleting the account cascades through threads to messages (the
    // hard-delete half of offboarding).
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [ACCOUNT_ID]);
    const left = await pool.query(`SELECT count(*) AS count FROM web_messages`);
    expect(Number(left.rows[0].count)).toBe(0);
  });
});

describe("threads", () => {
  it("creates a thread bound to one assistant, and renames it without rebinding", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Trip planning" },
      ACCOUNT_ID,
      db,
    );
    expect(thread).toMatchObject({ assistantId: ASSISTANT_ID, name: "Trip planning" });

    const renamed = await service.renameChatThread(thread.id, "Autumn trip", ACCOUNT_ID, db);
    expect(renamed).toMatchObject({
      id: thread.id,
      name: "Autumn trip",
      // The binding is fixed at creation — a rename must not move it.
      assistantId: ASSISTANT_ID,
    });
  });

  it("starts a chat nameless and lets the pipeline name it from the first exchange", async () => {
    const thread = await service.createChatThread({ assistantId: ASSISTANT_ID }, ACCOUNT_ID, db);
    expect(thread).toMatchObject({ name: "New chat", titleProvisional: true });

    await service.postChatMessage(
      thread.id,
      { text: "how do I get to the airport?" },
      { db },
    );
    // The event asks for a name — that flag is the whole request.
    expect(enqueued.at(-1)!.chat).toMatchObject({ titleProvisional: true });

    // Outbound `setChatTitle` names it exactly once; the pieces run on the
    // suite's db handle so the outbound port (env-bound) is exercised via the
    // repository it delegates to.
    const named = await repository.setGeneratedTitle(thread.id, "Getting to the airport", db);
    expect(named?.name).toBe("Getting to the airport");

    await service.postChatMessage(thread.id, { text: "and back again?" }, { db });
    expect(enqueued.at(-1)!.chat.titleProvisional).toBe(false);

    // A late generated title cannot overwrite the name it already has.
    const late = await repository.setGeneratedTitle(thread.id, "Something else", db);
    expect(late).toBeNull();
  });

  it("stops asking to be named once someone names it by hand", async () => {
    const thread = await service.createChatThread({ assistantId: ASSISTANT_ID }, ACCOUNT_ID, db);
    const renamed = await service.renameChatThread(thread.id, "My own name for it", ACCOUNT_ID, db);
    expect(renamed).toMatchObject({ name: "My own name for it", titleProvisional: false });
    expect(await repository.setGeneratedTitle(thread.id, "A generated one", db)).toBeNull();
  });
});

describe("posting", () => {
  it("stores the message and enqueues one addressed turn", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Questions" },
      ACCOUNT_ID,
      db,
    );
    const posted = await service.postChatMessage(thread.id, { text: "are you there?" }, { db });
    expect(posted.message).toMatchObject({ role: "user", content: "are you there?" });
    expect(posted.correlationId).toBe(`${thread.id}:${posted.message.id}:${ASSISTANT_ID}`);

    expect(enqueued).toHaveLength(1);
    const event = enqueued[0];
    expect(event).toMatchObject({
      source: "chat",
      assistantId: ASSISTANT_ID,
      chat: { ref: `chat:thread:${thread.id}`, kind: "direct", title: "Questions" },
      // A message typed into a thread is addressed to that thread's
      // assistant: there is nobody else in the room to mean.
      addressing: { addressed: true, source: "private", needsAnalyzer: false },
    });
    // A web thread has no bot account, so the event carries no connection
    // identity and the pipeline uses the assistant's own name.
    expect(event.connection).toBeUndefined();
    expect(event.sender.isOwner).toBe(true);
    expect(event.context.participants).toHaveLength(1);
    // The turn's own message is not part of its history window.
    expect(event.context.history).toHaveLength(0);
  });

  it("carries the running conversation as the window, the current turn excluded", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Ongoing" },
      ACCOUNT_ID,
      db,
    );
    for (const text of ["first", "second"]) {
      await service.postChatMessage(thread.id, { text }, { db });
    }
    // An assistant line between them, exactly as delivery stores it.
    await repository.appendMessage(
      { threadId: thread.id, role: "assistant", content: "an answer" },
      db,
    );
    await service.postChatMessage(thread.id, { text: "third" }, { db });

    const last = enqueued.at(-1)!;
    expect(last.context.history.map((line) => [line.role, line.content])).toEqual([
      ["user", "first"],
      ["user", "second"],
      ["assistant", "an answer"],
    ]);
    // Whose words the assistant lines are: the thread's own assistant.
    expect(last.context.history.at(-1)).toMatchObject({ assistantId: ASSISTANT_ID });
    expect(last.context.history[0].senderRef).toMatch(/^chat:user:/);
  });

  it("stores an uploaded image as pending media, normalized, and keeps it after describing", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "With a picture" },
      ACCOUNT_ID,
      db,
    );
    // A real (tiny) PNG — the service normalizes whatever the browser sends.
    const png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const posted = await service.postChatMessage(
      thread.id,
      { text: "what is this?", image: { dataBase64: png.toString("base64"), mimeType: "image/png" } },
      { db },
    );
    expect(posted.message.media).toMatchObject({ kind: "image", status: "pending" });
    const mediaId = posted.message.media!.id;

    // The event references it the way a Telegram photo does.
    expect(enqueued.at(-1)!.message.media).toEqual([
      { id: mediaId, kind: "image", status: "pending", description: null },
    ]);

    // The describe pass: the work list, the bytes, the write-back.
    const pending = await mediaRepository.listPendingMediaRefs(10, db);
    expect(pending.some((row) => row.id === mediaId && row.threadId === thread.id)).toBe(true);

    const withBytes = await mediaRepository.getMediaById(mediaId, db);
    // Normalized to JPEG regardless of what was uploaded.
    expect(withBytes?.mimeType).toBe("image/jpeg");
    expect(withBytes?.frames).toHaveLength(1);

    const described = await mediaRepository.markDescribed(mediaId, "a solid blue square", db);
    expect(described).toMatchObject({ status: "described", description: "a solid blue square" });
    // The picture survives being described — a web thread is its only archive.
    expect(described?.frames).toHaveLength(1);

    // …and the transcript carries the description with the line.
    const body = await service.getChatThread(thread.id, ACCOUNT_ID, db);
    expect(body.messages[0].media).toMatchObject({
      id: mediaId,
      status: "described",
      description: "a solid blue square",
    });
  });

  it("answers on the text when an upload cannot be read as an image", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Broken upload" },
      ACCOUNT_ID,
      db,
    );
    const posted = await service.postChatMessage(
      thread.id,
      {
        text: "look at this",
        image: { dataBase64: Buffer.from("not an image at all").toString("base64") },
      },
      { db },
    );
    expect(posted.message.media).toBeNull();
    // The turn still runs — losing the message would be the worse failure.
    expect(enqueued.at(-1)!.message).toMatchObject({ content: "look at this", media: [] });
  });

  it("takes a voice note in, stored raw", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Spoken" },
      ACCOUNT_ID,
      db,
    );
    const recorded = Buffer.from("not really opus, but bytes are bytes");
    const posted = await service.postChatMessage(
      thread.id,
      { text: "", audio: { dataBase64: recorded.toString("base64"), mimeType: "audio/webm" } },
      { db },
    );
    expect(posted.message).toMatchObject({
      content: "",
      media: { kind: "voice", status: "pending" },
    });
    const stored = await mediaRepository.getMediaById(posted.message.media!.id, db);
    expect(Buffer.from(stored!.frames[0], "base64").toString()).toBe(recorded.toString());
  });
});

describe("delivery", () => {
  const deliveryEvent = (threadId: string, text: string): ReplyDeliveryEvent => ({
    v: 1,
    eventId: `evt-${text}`,
    occurredAt: new Date().toISOString(),
    correlationId: `${threadId}:1:${ASSISTANT_ID}`,
    type: "reply.delivery",
    source: "chat",
    assistantId: ASSISTANT_ID,
    chatRef: `chat:thread:${threadId}`,
    threadId: null,
    replyToSourceMessageId: null,
    text,
    silent: false,
  });

  // The delivery handler runs on the process db (it is the bus consumer's
  // half); bind the suite's handle for its duration.
  it("stores a delivered reply, and drops one for a thread that is gone", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Answered" },
      ACCOUNT_ID,
      db,
    );
    const repoSpy = vi
      .spyOn(await import("@/server/store/db"), "getStoreDb")
      .mockReturnValue(db);
    try {
      await deliveryModule.handleChatReplyDelivery(deliveryEvent(thread.id, "yes, I am here"));
      const body = await service.getChatThread(thread.id, ACCOUNT_ID, db);
      expect(body.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "yes, I am here",
      });

      // A thread deleted mid-turn: the reply has nowhere to go, and that is
      // survivable — the handler must not throw.
      await expect(
        deliveryModule.handleChatReplyDelivery(deliveryEvent("deleted-thread", "into the void")),
      ).resolves.toBeUndefined();
    } finally {
      repoSpy.mockRestore();
    }
  });
});

describe("outbound port", () => {
  it("delivers, retracts, and serves voice, images and files", async () => {
    const thread = await service.createChatThread(
      { assistantId: ASSISTANT_ID, name: "Tools at work" },
      ACCOUNT_ID,
      db,
    );
    {
      const outbound = outboundModule.webChatOutbound();
      const sent = await outbound.sendMessage(thread.id, { text: "looking that up…" });
      expect(sent.messageId).toBeGreaterThan(0);

      const voice = await outbound.sendVoice(thread.id, {
        audioBase64: Buffer.from("spoken bytes").toString("base64"),
        text: "here is what I found",
        replyToMessageId: sent.messageId,
      });
      expect(voice.asVoice).toBe(true);

      const photos = await outbound.sendPhotos(thread.id, {
        images: [Buffer.from("png-ish").toString("base64")],
      });
      expect(photos.delivered).toHaveLength(1);
      expect(photos.delivered[0].stored).toBe(true);

      const file = await outbound.sendFile(thread.id, {
        buffer: Buffer.from("a downloaded thing"),
        filename: "report.txt",
        mime: "text/plain",
        caption: "the report you asked for",
      });
      expect(file.messageId).toBeGreaterThan(0);

      // Retract the first send: soft — the transcript hides it, the operator
      // listing still shows what happened.
      const deleted = await outbound.deleteMessage(thread.id, sent.messageId);
      expect(deleted.deleted).toBe(true);
      const body = await service.getChatThread(thread.id, ACCOUNT_ID, db);
      expect(body.messages.map((m) => m.media?.kind ?? null)).toEqual(["voice", "image", "file"]);
      // The voice reply's content is the spoken text — what the window reads.
      expect(body.messages[0]).toMatchObject({
        role: "assistant",
        content: "here is what I found",
        media: { kind: "voice", status: "described", description: "here is what I found" },
      });
      const all = await repository.listThreadMessages(thread.id, db);
      expect(all).toHaveLength(4);
      expect(all[0].deletedAt).not.toBeNull();
    }
  });
});

describe("directory client", () => {
  it("serves the operator listing contract from the store", async () => {
    {
      const thread = await service.createChatThread(
        { assistantId: ASSISTANT_ID, name: "Listed" },
        ACCOUNT_ID,
        db,
      );
      await service.postChatMessage(thread.id, { text: "hello" }, { db });

      const client = webChatDirectoryClient();
      const users = await client.listUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ label: "Operator", username: "operator" });

      const chats = await client.listChats();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({
        id: thread.id,
        kind: "direct",
        title: "Listed",
        messageCount: 1,
        memberCount: 1,
      });

      const members = await client.listChatMembers(thread.id);
      expect(members).toHaveLength(1);
      expect(members[0].label).toBe("Operator");

      const updated = await client.updateChat(thread.id, { notes: "the operator's own chat" });
      expect(updated.notes).toBe("the operator's own chat");

      expect(await client.getChat("missing")).toBeNull();
    }
  });
});

describe("delivery tools", () => {
  it("are offered only on web-chat turns, each for its own delivery kind", () => {
    expect(webChatToolOffered(CHAT_REPLY_TOOL, { source: "chat", delivery: "reply" })).toBe(true);
    expect(webChatToolOffered(CHAT_SEND_TOOL, { source: "chat", delivery: "send" })).toBe(true);
    // The wrong kind, the wrong source, or an ordinary reply: not offered.
    expect(webChatToolOffered(CHAT_REPLY_TOOL, { source: "chat", delivery: "send" })).toBe(false);
    expect(webChatToolOffered(CHAT_SEND_TOOL, { source: "tg", delivery: "send" })).toBe(false);
    expect(webChatToolOffered(CHAT_REPLY_TOOL, { source: "chat", delivery: null })).toBe(false);
  });
});
