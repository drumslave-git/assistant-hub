import { fileURLToPath } from "node:url";

import { openPublisher, openQueue, openWorker } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  chatThreadResponseSchema,
  chatPostMessageResponseSchema,
  chatThreadCreatedResponseSchema,
  inboundMessageEventSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import { applyMigrations, startTestPostgres, type TestPostgres } from "@assistant-hub/db/testing";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import { startDeliveryConsumer } from "./delivery";
import { ThreadTurns } from "./turns";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

const TOKEN = "secret-token";
const HEADERS = { "x-internal-token": TOKEN, "content-type": "application/json" };
const ASSISTANT_ID = "assistant-fixture";

/**
 * The chat app as a source: a human posts into a thread, one normalized
 * inbound event reaches the real queue, and the core's reply-delivery event
 * comes back over the real bus and lands in the transcript. Everything
 * between those two points is the core's pipeline, which this app never sees
 * — so the test drives exactly the two ends this app owns.
 */
describe("chat runtime", () => {
  let pg: TestPostgres;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      startTestPostgres(),
      new GenericContainer("redis:7-alpine").withExposedPorts(6379).start(),
    ]);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const url = await pg.createDatabase("chat_runtime");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await Promise.all([pg?.stop(), redis?.stop()]);
  });

  /** An API with an in-memory queue, for the cases that only need the event. */
  function apiWith(enqueued: InboundMessageEvent[]) {
    return createApi({
      db,
      internalToken: TOKEN,
      enqueue: async (event) => {
        enqueued.push(event);
      },
    });
  }

  async function newThread(app: ReturnType<typeof createApi>, name?: string) {
    const created = chatThreadCreatedResponseSchema.parse(
      await (
        await app.request("/internal/threads", {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ assistantId: ASSISTANT_ID, ...(name ? { name } : {}) }),
        })
      ).json(),
    );
    return created.thread;
  }

  it("creates a thread bound to one assistant, and renames it without rebinding", async () => {
    const app = apiWith([]);
    const thread = await newThread(app, "Trip planning");
    expect(thread).toMatchObject({ assistantId: ASSISTANT_ID, name: "Trip planning" });

    const renamed = chatThreadCreatedResponseSchema.parse(
      await (
        await app.request(`/internal/threads/${thread.id}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ name: "Autumn trip" }),
        })
      ).json(),
    );
    expect(renamed.thread).toMatchObject({
      id: thread.id,
      name: "Autumn trip",
      // The binding is fixed at creation — a rename must not move it.
      assistantId: ASSISTANT_ID,
    });
  });

  it("posting a message stores it and enqueues one addressed turn", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);
    const thread = await newThread(app, "Questions");

    const posted = chatPostMessageResponseSchema.parse(
      await (
        await app.request(`/internal/threads/${thread.id}/messages`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ text: "are you there?" }),
        })
      ).json(),
    );
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
    // identity and the core uses the assistant's own name.
    expect(event.connection).toBeUndefined();
    expect(event.sender.isOwner).toBe(true);
    expect(event.context.participants).toHaveLength(1);
    // The turn's own message is not part of its history window.
    expect(event.context.history).toHaveLength(0);
  });

  it("carries the running conversation as the window, the current turn excluded", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);
    const thread = await newThread(app, "Ongoing");

    for (const text of ["first", "second"]) {
      await app.request(`/internal/threads/${thread.id}/messages`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ text }),
      });
    }
    // An assistant line between them, exactly as delivery would store it.
    await app.request(`/internal/chats/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "an answer" }),
    });
    await app.request(`/internal/threads/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "third" }),
    });

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

  it("refuses to store a message it cannot start a turn for", async () => {
    const app = createApi({ db, internalToken: TOKEN });
    const thread = await newThread(apiWith([]), "No queue");
    const res = await app.request(`/internal/threads/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "anyone?" }),
    });
    expect(res.status).toBe(503);
    const after = chatThreadResponseSchema.parse(
      await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
    );
    expect(after.messages).toHaveLength(0);
  });

  it("enqueued events reach a queue worker intact", async () => {
    const queue = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl);
    const consumed: InboundMessageEvent[] = [];
    const worker = openWorker<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl, async (job) => {
      consumed.push(inboundMessageEventSchema.parse(job.data));
    });
    try {
      const app = createApi({
        db,
        internalToken: TOKEN,
        enqueue: async (event) => {
          await queue.add("message.inbound", event);
        },
      });
      const thread = await newThread(app, "Over the queue");
      const res = await app.request(`/internal/threads/${thread.id}/messages`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ text: "does this travel?" }),
      });
      expect(res.status).toBe(200);
      await expect.poll(() => consumed.length, { timeout: 15_000 }).toBe(1);
      expect(consumed[0]).toMatchObject({
        source: "chat",
        chat: { ref: `chat:thread:${thread.id}` },
        message: { content: "does this travel?" },
      });
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("stores a reply delivered over the bus, and drops one for a thread that is gone", async () => {
    const app = apiWith([]);
    const thread = await newThread(app, "Answered");
    const consumer = await startDeliveryConsumer({ db, redisUrl });
    const publisher = openPublisher(redisUrl);
    try {
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d1",
        occurredAt: new Date().toISOString(),
        correlationId: `${thread.id}:1:${ASSISTANT_ID}`,
        type: "reply.delivery",
        source: "chat",
        assistantId: ASSISTANT_ID,
        chatRef: `chat:thread:${thread.id}`,
        text: "yes, I am here",
      });
      await expect
        .poll(
          async () => {
            const body = chatThreadResponseSchema.parse(
              await (
                await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })
              ).json(),
            );
            return body.messages.length;
          },
          { timeout: 15_000 },
        )
        .toBe(1);

      const body = chatThreadResponseSchema.parse(
        await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
      );
      expect(body.messages[0]).toMatchObject({ role: "assistant", content: "yes, I am here" });

      // A thread deleted mid-turn: the reply has nowhere to go, and that is
      // survivable — the consumer must keep running for every other thread.
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d2",
        occurredAt: new Date().toISOString(),
        correlationId: `gone:1:${ASSISTANT_ID}`,
        type: "reply.delivery",
        source: "chat",
        assistantId: ASSISTANT_ID,
        chatRef: "chat:thread:deleted-thread",
        text: "into the void",
      });
      // Still delivering afterwards is the assertion that matters.
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d3",
        occurredAt: new Date().toISOString(),
        correlationId: `${thread.id}:2:${ASSISTANT_ID}`,
        type: "reply.delivery",
        source: "chat",
        assistantId: ASSISTANT_ID,
        chatRef: `chat:thread:${thread.id}`,
        text: "and still here",
      });
      await expect
        .poll(
          async () => {
            const after = chatThreadResponseSchema.parse(
              await (
                await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })
              ).json(),
            );
            return after.messages.length;
          },
          { timeout: 15_000 },
        )
        .toBe(2);
    } finally {
      await publisher.close();
      await consumer.close();
    }
  });

  it("retracts a delivered message without leaving a hole in the transcript", async () => {
    const app = apiWith([]);
    const thread = await newThread(app, "Retractions");
    const sent = (await (
      await app.request(`/internal/chats/${thread.id}/messages`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ text: "looking that up…" }),
      })
    ).json()) as { sourceMessageId: string };

    const deleted = (await (
      await app.request(`/internal/chats/${thread.id}/messages/${sent.sourceMessageId}`, {
        method: "DELETE",
        headers: HEADERS,
      })
    ).json()) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    const body = chatThreadResponseSchema.parse(
      await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
    );
    expect(body.messages).toHaveLength(0);
    // Retracted, not erased: the operator listing still shows what happened.
    const operator = (await (
      await app.request(`/internal/chats/${thread.id}/messages`, { headers: HEADERS })
    ).json()) as { messages: Array<{ deletedAt: string | null }> };
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0].deletedAt).not.toBeNull();
  });

  it("shows what the core is doing in the thread, and stops when it settles", async () => {
    const turns = new ThreadTurns();
    const app = createApi({ db, internalToken: TOKEN, turns, enqueue: async () => {} });
    const thread = await newThread(app, "Live progress");
    const consumer = await startDeliveryConsumer({ db, redisUrl, turns });
    const publisher = openPublisher(redisUrl);

    const readTurn = async () => {
      const body = chatThreadResponseSchema.parse(
        await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
      );
      return body.turn;
    };
    const lifecycle = (phase: "accepted" | "progress" | "settled", activity?: string) => ({
      v: 1,
      eventId: `evt-${phase}-${activity ?? "none"}`,
      occurredAt: new Date().toISOString(),
      correlationId: `${thread.id}:1:${ASSISTANT_ID}`,
      type: "turn.lifecycle",
      source: "chat",
      assistantId: ASSISTANT_ID,
      chatRef: `chat:thread:${thread.id}`,
      sourceMessageId: "1",
      phase,
      ...(activity ? { activity } : {}),
    });

    try {
      expect(await readTurn()).toBeNull();

      await publisher.publish(BUS_EVENTS_CHANNEL, lifecycle("accepted"));
      await expect.poll(async () => (await readTurn())?.sourceMessageId, { timeout: 15_000 }).toBe(
        "1",
      );

      await publisher.publish(BUS_EVENTS_CHANNEL, lifecycle("progress", "browse_web"));
      await expect
        .poll(async () => (await readTurn())?.activity, { timeout: 15_000 })
        .toBe("browse_web");

      await publisher.publish(BUS_EVENTS_CHANNEL, lifecycle("settled"));
      await expect.poll(async () => await readTurn(), { timeout: 15_000 }).toBeNull();
    } finally {
      await publisher.close();
      await consumer.close();
    }
  });

  it("stores an uploaded image as pending media and hands the core its bytes", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);
    const thread = await newThread(app, "With a picture");
    // A real (tiny) PNG — the app normalizes whatever the browser sends.
    const png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const posted = chatPostMessageResponseSchema.parse(
      await (
        await app.request(`/internal/threads/${thread.id}/messages`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({
            text: "what is this?",
            image: { dataBase64: png.toString("base64"), mimeType: "image/png" },
          }),
        })
      ).json(),
    );
    expect(posted.message.media).toMatchObject({ kind: "image", status: "pending" });
    const mediaId = posted.message.media!.id;

    // The event references it the way a Telegram photo does.
    expect(enqueued.at(-1)!.message.media).toEqual([
      { id: mediaId, kind: "image", status: "pending", description: null },
    ]);

    // The core's describe pass: the work list, the bytes, the write-back.
    const pending = (await (
      await app.request("/internal/media/pending?limit=10", { headers: HEADERS })
    ).json()) as { media: Array<{ id: string; chatId: string }>; total: number };
    expect(pending.media.some((row) => row.id === mediaId && row.chatId === thread.id)).toBe(true);

    const withBytes = (await (
      await app.request(`/internal/media/${mediaId}`, { headers: HEADERS })
    ).json()) as { media: { frames: string[]; mimeType: string | null } };
    // Normalized to JPEG regardless of what was uploaded.
    expect(withBytes.media.mimeType).toBe("image/jpeg");
    expect(withBytes.media.frames).toHaveLength(1);

    const described = (await (
      await app.request(`/internal/media/${mediaId}/description`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ description: "a solid blue square" }),
      })
    ).json()) as { updated: boolean; media: { status: string; description: string } };
    expect(described).toMatchObject({
      updated: true,
      media: { status: "described", description: "a solid blue square" },
    });

    // The picture survives being described — a web thread is its only archive.
    const bytes = await app.request(`/internal/media/${mediaId}/bytes`, { headers: HEADERS });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/jpeg");
    expect((await bytes.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // …and the transcript carries the description with the line.
    const body = chatThreadResponseSchema.parse(
      await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
    );
    expect(body.messages[0].media).toMatchObject({
      id: mediaId,
      status: "described",
      description: "a solid blue square",
    });
  });

  it("answers on the text when an upload cannot be read as an image", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);
    const thread = await newThread(app, "Broken upload");
    const res = await app.request(`/internal/threads/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        text: "look at this",
        image: { dataBase64: Buffer.from("not an image at all").toString("base64") },
      }),
    });
    expect(res.status).toBe(200);
    // The turn still runs — losing the message would be the worse failure.
    expect(enqueued.at(-1)!.message).toMatchObject({ content: "look at this", media: [] });
  });

  it("takes a voice note in and gives a voice reply back", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);
    const thread = await newThread(app, "Spoken");

    // Inbound: the bytes are stored as-is — the core converts before
    // transcribing, exactly as it does for Telegram audio.
    const recorded = Buffer.from("not really opus, but bytes are bytes");
    const posted = chatPostMessageResponseSchema.parse(
      await (
        await app.request(`/internal/threads/${thread.id}/messages`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({
            audio: { dataBase64: recorded.toString("base64"), mimeType: "audio/webm" },
          }),
        })
      ).json(),
    );
    expect(posted.message).toMatchObject({ content: "", media: { kind: "voice", status: "pending" } });
    expect(enqueued.at(-1)!.message.media).toEqual([
      { id: posted.message.media!.id, kind: "voice", status: "pending", description: null },
    ]);
    const stored = (await (
      await app.request(`/internal/media/${posted.message.media!.id}`, { headers: HEADERS })
    ).json()) as { media: { frames: string[]; mimeType: string } };
    expect(Buffer.from(stored.media.frames[0], "base64").toString()).toBe(recorded.toString());

    // Outbound: the core's TTS lands as an assistant message whose CONTENT is
    // the spoken text — that is what the window and the next turn read.
    const sent = (await (
      await app.request(`/internal/chats/${thread.id}/voice`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          audioBase64: Buffer.from("spoken bytes").toString("base64"),
          text: "here is what I found",
          replyToSourceMessageId: posted.message.id,
        }),
      })
    ).json()) as { sourceMessageId: string; asVoice: boolean };
    expect(sent.asVoice).toBe(true);

    const body = chatThreadResponseSchema.parse(
      await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
    );
    const reply = body.messages.find((message) => message.id === sent.sourceMessageId)!;
    expect(reply).toMatchObject({
      role: "assistant",
      content: "here is what I found",
      // Born described: its words ARE the message text, so the backfill has
      // no reason to go listening to the assistant's own voice.
      media: { kind: "voice", status: "described", description: "here is what I found" },
    });
    const audio = await app.request(`/internal/media/${reply.media!.id}/bytes`, {
      headers: HEADERS,
    });
    expect(audio.headers.get("content-type")).toBe("audio/ogg");
  });

  it("serves the rest of the outbound port: images, files, and an honest refusal", async () => {
    const app = apiWith([]);
    const thread = await newThread(app, "Tools at work");

    const photos = (await (
      await app.request(`/internal/chats/${thread.id}/photos`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ images: [Buffer.from("png-ish").toString("base64")] }),
      })
    ).json()) as { delivered: Array<{ sourceMessageId: string; stored: boolean }> };
    expect(photos.delivered).toHaveLength(1);
    expect(photos.delivered[0].stored).toBe(true);

    const file = (await (
      await app.request(`/internal/chats/${thread.id}/files`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          dataBase64: Buffer.from("a downloaded thing").toString("base64"),
          filename: "report.txt",
          mime: "text/plain",
          caption: "the report you asked for",
        }),
      })
    ).json()) as { sourceMessageId: string };
    expect(file.sourceMessageId).toBeTruthy();

    // Reactions do not exist here, and the source says so rather than
    // throwing — the tool then tells the model the truth.
    const reaction = (await (
      await app.request(`/internal/chats/${thread.id}/messages/${file.sourceMessageId}/reaction`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ emoji: "👍" }),
      })
    ).json()) as { status: string };
    expect(reaction.status).toBe("unsupported");

    const body = chatThreadResponseSchema.parse(
      await (await app.request(`/internal/threads/${thread.id}`, { headers: HEADERS })).json(),
    );
    expect(body.messages.map((m) => m.media?.kind)).toEqual(["image", "file"]);
  });

  it("starts a chat nameless and lets the core name it from the first exchange", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const app = apiWith(enqueued);

    // No name given: nobody titles a conversation before having it.
    const thread = await newThread(app);
    expect(thread).toMatchObject({ name: "New chat", titleProvisional: true });

    await app.request(`/internal/threads/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "how do I get to the airport?" }),
    });
    // The event asks for a name — that flag is the whole request.
    expect(enqueued.at(-1)!.chat).toMatchObject({ titleProvisional: true });

    const named = (await (
      await app.request(`/internal/chats/${thread.id}/title`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ title: "Getting to the airport" }),
      })
    ).json()) as { title: string };
    expect(named.title).toBe("Getting to the airport");

    // Named once: a second turn no longer asks, and a late title cannot
    // overwrite the name it already has.
    await app.request(`/internal/threads/${thread.id}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "and back again?" }),
    });
    expect(enqueued.at(-1)!.chat.titleProvisional).toBe(false);

    const late = (await (
      await app.request(`/internal/chats/${thread.id}/title`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ title: "Something else entirely" }),
      })
    ).json()) as { title: string };
    expect(late.title).toBe("Getting to the airport");
  });

  it("stops asking to be named once someone names it by hand", async () => {
    const app = apiWith([]);
    const thread = await newThread(app);
    const renamed = chatThreadCreatedResponseSchema.parse(
      await (
        await app.request(`/internal/threads/${thread.id}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ name: "My own name for it" }),
        })
      ).json(),
    );
    expect(renamed.thread).toMatchObject({
      name: "My own name for it",
      titleProvisional: false,
    });

    const attempt = (await (
      await app.request(`/internal/chats/${thread.id}/title`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ title: "A generated one" }),
      })
    ).json()) as { title: string };
    expect(attempt.title).toBe("My own name for it");
  });
});
