import { fileURLToPath } from "node:url";

import { openPublisher, openQueue, openWorker } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  inboundMessageEventSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import type { Message } from "@grammyjs/types";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { startDeliveryConsumer, type TgSender } from "./delivery";
import { processIncomingMessage } from "./inbound";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

/** Synthetic grammY message — invented ids/names only. */
function tgMessage(input: {
  messageId: number;
  chatId: number;
  group?: boolean;
  text: string;
  from: { id: number; username?: string; firstName?: string };
  replyTo?: { messageId: number; text: string; fromId: number; fromBot?: boolean };
  dateSeconds?: number;
}): Message {
  return {
    message_id: input.messageId,
    date: input.dateSeconds ?? Math.floor(Date.now() / 1000),
    chat: input.group
      ? ({ id: input.chatId, type: "supergroup", title: "Fixture Group" } as Message["chat"])
      : ({ id: input.chatId, type: "private", first_name: "Peer" } as Message["chat"]),
    from: {
      id: input.from.id,
      is_bot: false,
      first_name: input.from.firstName ?? "Someone",
      username: input.from.username,
    },
    text: input.text,
    ...(input.replyTo
      ? {
          reply_to_message: {
            message_id: input.replyTo.messageId,
            date: (input.dateSeconds ?? Math.floor(Date.now() / 1000)) - 60,
            chat: { id: input.chatId, type: input.group ? "supergroup" : "private" },
            from: {
              id: input.replyTo.fromId,
              is_bot: input.replyTo.fromBot ?? false,
              first_name: input.replyTo.fromBot ? "FixtureBot" : "Bob",
            },
            text: input.replyTo.text,
          },
        }
      : {}),
  } as Message;
}

describe("tg runtime", () => {
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
    const url = await pg.createDatabase("tg_runtime");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });

    await pool.query(
      `INSERT INTO settings (id, owner_username) VALUES ('singleton', 'owner_example')`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
    await redis?.stop();
  });

  it("mirrors, resolves the owner, composes context, and enqueues one valid event", async () => {
    const enqueued: InboundMessageEvent[] = [];
    const deps = {
      db,
      assistantId: "assistant-1",
      identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
      botId: 999,
      enqueue: async (event: InboundMessageEvent) => {
        enqueued.push(event);
      },
    };

    // Prior traffic for the window: an earlier message from another sender.
    const earlier = await processIncomingMessage(
      tgMessage({
        messageId: 10,
        chatId: -300,
        group: true,
        text: "earlier chatter",
        from: { id: 5002, username: "bob_example", firstName: "Bob" },
      }),
      deps,
    );
    expect(earlier.status).toBe("enqueued");

    // The current turn: the owner (by username, not yet resolved) replying
    // to the assistant's own message.
    const result = await processIncomingMessage(
      tgMessage({
        messageId: 11,
        chatId: -300,
        group: true,
        text: "hey bot, do the thing",
        from: { id: 5001, username: "owner_example", firstName: "Alice" },
        replyTo: { messageId: 9, text: "assistant said this", fromId: 999, fromBot: true },
      }),
      deps,
    );
    expect(result.status).toBe("enqueued");
    expect(enqueued).toHaveLength(2);
    const event = inboundMessageEventSchema.parse(enqueued[1]);

    // The event is addressed and scoped correctly.
    expect(event.assistantId).toBe("assistant-1");
    expect(event.connection).toEqual({ botUsername: "fixture_bot", botDisplayName: "Fixture" });
    expect(event.chat).toMatchObject({ ref: "tg:chat:-300", kind: "group", title: "Fixture Group" });
    expect(event.correlationId).toBe("-300:11");

    // The owner was resolved from the configured username and persisted.
    expect(event.sender).toMatchObject({
      ref: "tg:user:5001",
      isOwner: true,
      label: "Alice (@owner_example)",
    });
    const settings = await pool.query(`SELECT owner_user_id FROM settings`);
    expect(settings.rows[0].owner_user_id).toBe("5001");

    // The reply target marks the assistant's own message without a label.
    expect(event.message.replyTo).toMatchObject({
      sourceMessageId: "9",
      fromAssistant: true,
      senderLabel: null,
      text: "assistant said this",
    });

    // The context window holds the earlier message (not the current turn),
    // labelled from the stored profile; the roster knows both humans.
    expect(event.context.history).toHaveLength(1);
    expect(event.context.history[0]).toMatchObject({
      sourceMessageId: "10",
      role: "user",
      senderRef: "tg:user:5002",
      senderLabel: "Bob (@bob_example)",
      content: "earlier chatter",
    });
    expect(event.context.participants.map((p) => p.ref).sort()).toEqual([
      "tg:user:5001",
      "tg:user:5002",
    ]);

    // Both messages are mirrored, held unprocessed for the live turn.
    const mirrored = await pool.query(
      `SELECT telegram_message_id, role, processed FROM messages ORDER BY id`,
    );
    expect(mirrored.rows).toEqual([
      { telegram_message_id: "10", role: "user", processed: false },
      { telegram_message_id: "11", role: "user", processed: false },
    ]);

    // A re-delivered update mirrors nothing and enqueues nothing.
    const redelivered = await processIncomingMessage(
      tgMessage({
        messageId: 11,
        chatId: -300,
        group: true,
        text: "hey bot, do the thing",
        from: { id: 5001, username: "owner_example", firstName: "Alice" },
      }),
      deps,
    );
    expect(redelivered.status).toBe("skipped");
    expect(enqueued).toHaveLength(2);
  });

  it("enqueued events reach a queue worker intact", async () => {
    const queue = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl);
    const consumed: InboundMessageEvent[] = [];
    const worker = openWorker<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl, async (job) => {
      consumed.push(inboundMessageEventSchema.parse(job.data));
    });
    try {
      const result = await processIncomingMessage(
        tgMessage({
          messageId: 21,
          chatId: 5001,
          text: "dm to the bot",
          from: { id: 5001, username: "owner_example", firstName: "Alice" },
        }),
        {
          db,
          assistantId: "assistant-1",
          identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
          botId: 999,
          enqueue: async (event) => {
            await queue.add("message.inbound", event);
          },
        },
      );
      expect(result.status).toBe("enqueued");
      await expect.poll(() => consumed.length, { timeout: 15_000 }).toBe(1);
      expect(consumed[0].chat).toMatchObject({ ref: "tg:chat:5001", kind: "direct" });
      expect(consumed[0].sender.isOwner).toBe(true);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("delivers replies from the bus, mirrors them, and runs typing across the turn", async () => {
    const sends: Array<{ chatId: string; text: string; replyTo: number | null }> = [];
    let typingCalls = 0;
    const sender: TgSender = {
      sendReply: async (chatId, text, opts) => {
        sends.push({ chatId, text, replyTo: opts.replyToMessageId ?? null });
        return { messageId: 501 };
      },
      sendTyping: () => {
        typingCalls += 1;
      },
    };
    const consumer = await startDeliveryConsumer({
      db,
      redisUrl,
      senderFor: () => sender,
    });
    const publisher = openPublisher(redisUrl);
    try {
      const envelope = {
        v: 1 as const,
        eventId: "evt-l1",
        occurredAt: new Date().toISOString(),
        correlationId: "-300:11",
        source: "tg" as const,
        chatRef: "tg:chat:-300",
        sourceMessageId: "11",
      };
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        ...envelope,
        type: "turn.lifecycle",
        phase: "accepted",
      });
      await expect.poll(() => typingCalls, { timeout: 10_000 }).toBeGreaterThan(0);

      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d1",
        occurredAt: new Date().toISOString(),
        correlationId: "-300:11",
        type: "reply.delivery",
        source: "tg",
        assistantId: "assistant-1",
        chatRef: "tg:chat:-300",
        replyToSourceMessageId: "11",
        text: "the answer",
      });
      await expect.poll(() => sends.length, { timeout: 10_000 }).toBe(1);
      expect(sends[0]).toEqual({ chatId: "-300", text: "the answer", replyTo: 11 });

      await publisher.publish(BUS_EVENTS_CHANNEL, {
        ...envelope,
        type: "turn.lifecycle",
        phase: "settled",
      });
      // Settling releases the live-processing hold on the inbound message.
      await expect
        .poll(
          async () => {
            const row = await pool.query(
              `SELECT processed FROM messages WHERE chat_id = '-300' AND telegram_message_id = 11`,
            );
            return row.rows[0]?.processed;
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      // The delivered reply is mirrored as an assistant row.
      const mirrored = await pool.query(
        `SELECT role, content, reply_to_message_id FROM messages WHERE telegram_message_id = 501`,
      );
      expect(mirrored.rows).toEqual([
        { role: "assistant", content: "the answer", reply_to_message_id: "11" },
      ]);

      // Events for another source are not ours and change nothing.
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d2",
        occurredAt: new Date().toISOString(),
        correlationId: "x",
        type: "reply.delivery",
        source: "chat",
        assistantId: "assistant-1",
        chatRef: "chat:thread:t1",
        text: "not for telegram",
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(sends).toHaveLength(1);
    } finally {
      await publisher.close();
      await consumer.close();
    }
  });
});
