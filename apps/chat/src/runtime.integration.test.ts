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
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import { startDeliveryConsumer } from "./delivery";

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

  async function newThread(app: ReturnType<typeof createApi>, name: string) {
    const created = chatThreadCreatedResponseSchema.parse(
      await (
        await app.request("/internal/threads", {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ assistantId: ASSISTANT_ID, name }),
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
});
