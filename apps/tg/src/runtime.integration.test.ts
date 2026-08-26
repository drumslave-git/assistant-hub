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
import type { AssistantConnection } from "./audience";
import { createCrossFeed, recordAssistantMessage } from "./cross-feed";
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
      botToken: "12345:fixture-token",
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
    // One turn = one assistant acting on one message, so the receiver is part
    // of the correlation (several assistants can be handed the same message).
    expect(event.correlationId).toBe("-300:11:assistant-1");

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

  it("keeps two assistants' DM streams with the same person separate", async () => {
    // A DM's chat id is the PEER's user id — identical for every bot they
    // talk to — and Telegram numbers DM messages per (bot, peer) pair, so
    // both bots receive a "#1". Without the assistant dimension the second
    // mirror collides and its turn is silently dropped.
    const peerId = 7100;
    const enqueued: InboundMessageEvent[] = [];
    const depsFor = (assistantId: string, botUsername: string, botId: number) => ({
      db,
      assistantId,
      identity: { botUsername, botDisplayName: botUsername },
      botId,
      botToken: `${botId}:fixture-token`,
      enqueue: async (event: InboundMessageEvent) => {
        enqueued.push(event);
      },
    });
    const dm = (messageId: number, text: string) =>
      tgMessage({
        messageId,
        chatId: peerId,
        text,
        from: { id: peerId, username: "peer_example", firstName: "Peer" },
      });

    const first = await processIncomingMessage(dm(1, "hello bot a"), depsFor("assistant-a", "bot_a", 111));
    expect(first.status).toBe("enqueued");
    // The same person's first message to the OTHER bot carries the same id.
    const second = await processIncomingMessage(dm(1, "hello bot b"), depsFor("assistant-b", "bot_b", 222));
    expect(second.status).toBe("enqueued");

    // A follow-up to bot B composes ITS conversation only — bot A's stream
    // never leaks into the window.
    const followUp = await processIncomingMessage(
      dm(2, "just you, bot b"),
      depsFor("assistant-b", "bot_b", 222),
    );
    expect(followUp.status).toBe("enqueued");
    const event = inboundMessageEventSchema.parse(enqueued[2]);
    expect(event.context.history.map((h) => h.content)).toEqual(["hello bot b"]);

    // Idempotence still holds within one stream.
    const redelivered = await processIncomingMessage(
      dm(1, "hello bot b"),
      depsFor("assistant-b", "bot_b", 222),
    );
    expect(redelivered.status).toBe("skipped");
    const rows = await pool.query(
      `SELECT assistant_id, telegram_message_id FROM messages WHERE chat_id = '7100' ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { assistant_id: "assistant-a", telegram_message_id: "1" },
      { assistant_id: "assistant-b", telegram_message_id: "1" },
      { assistant_id: "assistant-b", telegram_message_id: "2" },
    ]);
  });

  it("hands a group message to every assistant in the chat, not just the poller that mirrored it", async () => {
    // The group mirror is ONE shared stream, so of the two pollers Telegram
    // delivered this message to, exactly one wins the insert. Before the
    // fan-out that made the loser's assistant miss the turn entirely — a
    // message naming it went unanswered whenever the other bot mirrored
    // first.
    const chatId = -702;
    const enqueued: InboundMessageEvent[] = [];
    const running: AssistantConnection[] = [
      {
        assistantId: "assistant-a",
        botId: 111,
        identity: { botUsername: "bot_a", botDisplayName: "Bot A" },
      },
      {
        assistantId: "assistant-b",
        botId: 222,
        identity: { botUsername: "bot_b", botDisplayName: "Bot B" },
      },
    ];
    const depsFor = (connection: AssistantConnection) => ({
      db,
      assistantId: connection.assistantId,
      identity: connection.identity,
      botId: connection.botId,
      botToken: `${connection.botId}:fixture-token`,
      running: () => running,
      enqueue: async (event: InboundMessageEvent) => {
        enqueued.push(event);
      },
    });
    const post = (messageId: number, text: string) =>
      tgMessage({
        messageId,
        chatId,
        group: true,
        text,
        from: { id: 5001, username: "alice_example", firstName: "Alice" },
      });

    // Both bots see the first message; presence is stamped by each poller as
    // it processes, so the fan-out reaches both from the second one on.
    await processIncomingMessage(post(1, "hello both"), depsFor(running[0]));
    await processIncomingMessage(post(1, "hello both"), depsFor(running[1]));
    enqueued.length = 0;

    // Now the message that matters: bot A's poller wins the mirror race and
    // bot B's sees it as already mirrored — yet BOTH get a turn.
    const winner = await processIncomingMessage(post(2, "@bot_b are you there?"), depsFor(running[0]));
    const loser = await processIncomingMessage(post(2, "@bot_b are you there?"), depsFor(running[1]));
    expect(winner.status).toBe("enqueued");
    expect(loser.status).toBe("skipped");
    expect(loser.reason).toBe("already_mirrored");

    expect(enqueued.map((e) => e.assistantId).sort()).toEqual(["assistant-a", "assistant-b"]);
    // Each turn is its own: its own connection identity, its own correlation.
    const forB = enqueued.find((e) => e.assistantId === "assistant-b")!;
    const forA = enqueued.find((e) => e.assistantId === "assistant-a")!;
    expect(forB.connection).toEqual({ botUsername: "bot_b", botDisplayName: "Bot B" });
    expect(forB.correlationId).toBe(`${chatId}:2:assistant-b`);
    expect(forA.correlationId).toBe(`${chatId}:2:assistant-a`);
    // …and its own structural verdict: the @mention names B, not A.
    expect(forB.addressing).toMatchObject({ addressed: true, source: "mention" });
    expect(forA.addressing).toMatchObject({ addressed: false, needsAnalyzer: true });
    // The shared window is composed once and is the same conversation for both.
    expect(forA.context.history.map((h) => h.sourceMessageId)).toEqual(["1"]);
    expect(forB.context.history.map((h) => h.sourceMessageId)).toEqual(["1"]);

    // Still exactly one mirror row: the group is one shared stream.
    const rows = await pool.query(
      `SELECT telegram_message_id, count(*)::int AS n FROM messages
        WHERE chat_id = $1 GROUP BY 1 ORDER BY 1`,
      [String(chatId)],
    );
    expect(rows.rows).toEqual([
      { telegram_message_id: "1", n: 1 },
      { telegram_message_id: "2", n: 1 },
    ]);
  });

  it("keeps a direct chat to the bot that received it", async () => {
    const peerId = 7400;
    const enqueued: InboundMessageEvent[] = [];
    const running: AssistantConnection[] = [
      {
        assistantId: "assistant-a",
        botId: 111,
        identity: { botUsername: "bot_a", botDisplayName: "Bot A" },
      },
      {
        assistantId: "assistant-b",
        botId: 222,
        identity: { botUsername: "bot_b", botDisplayName: "Bot B" },
      },
    ];
    const result = await processIncomingMessage(
      tgMessage({
        messageId: 1,
        chatId: peerId,
        text: "just you",
        from: { id: peerId, username: "peer_example", firstName: "Peer" },
      }),
      {
        db,
        assistantId: "assistant-a",
        identity: running[0].identity,
        botId: 111,
        botToken: "111:fixture-token",
        running: () => running,
        enqueue: async (event: InboundMessageEvent) => {
          enqueued.push(event);
        },
      },
    );
    expect(result.status).toBe("enqueued");
    expect(enqueued.map((e) => e.assistantId)).toEqual(["assistant-a"]);
    expect(enqueued[0].correlationId).toBe(`${peerId}:1:assistant-a`);
  });

  it("cross-feeds a delivered reply to the other assistants present in the chat", async () => {
    // Telegram never hands one bot another bot's message, so without this
    // two assistants in the same group can never answer each other.
    const chatId = -700;
    const enqueued: InboundMessageEvent[] = [];
    const running: AssistantConnection[] = [
      {
        assistantId: "assistant-a",
        botId: 111,
        identity: { botUsername: "bot_a", botDisplayName: "Bot A" },
      },
      {
        assistantId: "assistant-b",
        botId: 222,
        identity: { botUsername: "bot_b", botDisplayName: "Bot B" },
      },
      // In the manager's list, but never in this chat.
      {
        assistantId: "assistant-c",
        botId: 333,
        identity: { botUsername: "bot_c", botDisplayName: "Bot C" },
      },
    ];
    const crossFeed = createCrossFeed({
      db,
      running: () => running,
      enqueue: async (event) => {
        enqueued.push(event);
      },
    });
    const depsFor = (assistantId: string, botUsername: string, botId: number) => ({
      db,
      assistantId,
      identity: { botUsername, botDisplayName: botUsername },
      botId,
      botToken: `${botId}:fixture-token`,
      enqueue: async () => {},
    });

    // Both bots poll this group, which is how presence is recorded; the
    // human message is one shared mirror row.
    const human = tgMessage({
      messageId: 1,
      chatId,
      group: true,
      text: "what do you two think?",
      from: { id: 5001, username: "alice_example", firstName: "Alice" },
    });
    expect((await processIncomingMessage(human, depsFor("assistant-a", "bot_a", 111))).status).toBe(
      "enqueued",
    );
    expect((await processIncomingMessage(human, depsFor("assistant-b", "bot_b", 222))).status).toBe(
      "skipped",
    );

    // Assistant A answers. The mirror seam feeds it to the chat's others.
    const mirrored = await recordAssistantMessage(
      db,
      {
        chatId: String(chatId),
        assistantId: "assistant-a",
        telegramMessageId: 2,
        content: "I think so, @bot_b?",
        replyToMessageId: 1,
        sentAt: new Date(),
      },
      crossFeed,
    );
    expect(mirrored).not.toBeNull();
    await expect.poll(() => enqueued.length, { timeout: 5_000 }).toBe(1);

    // Only B — never the author, never a bot that does not poll this chat.
    const event = inboundMessageEventSchema.parse(enqueued[0]);
    expect(event.assistantId).toBe("assistant-b");
    expect(event.authoredByAssistantId).toBe("assistant-a");
    expect(event.connection).toEqual({ botUsername: "bot_b", botDisplayName: "Bot B" });
    // The sender is A's bot ACCOUNT; the core names the assistant itself.
    expect(event.sender).toMatchObject({ ref: "tg:user:111", isOwner: false });
    // Its @username in the text is a summons, exactly as from a person.
    expect(event.addressing).toMatchObject({ addressed: true, source: "mention" });
    // A turn per receiver, so the correlation cannot collide with A's.
    expect(event.correlationId).toBe(`${chatId}:2:assistant-b`);
    // The window is the shared group stream, with the human's message in it
    // and A's reply excluded (it IS the current turn).
    expect(event.context.history.map((h) => h.sourceMessageId)).toEqual(["1"]);
    expect(event.message.replyTo).toMatchObject({ sourceMessageId: "1", stored: true });

    // The reply was mirrored once, attributed to its author.
    const rows = await pool.query(
      `SELECT assistant_id, role FROM messages WHERE chat_id = $1 ORDER BY id`,
      [String(chatId)],
    );
    expect(rows.rows).toEqual([
      { assistant_id: null, role: "user" },
      { assistant_id: "assistant-a", role: "assistant" },
    ]);
  });

  it("never cross-feeds a silent acknowledgement, an empty message, or a DM", async () => {
    const chatId = -701;
    const enqueued: InboundMessageEvent[] = [];
    const crossFeed = createCrossFeed({
      db,
      running: () => [
        {
          assistantId: "assistant-a",
          botId: 111,
          identity: { botUsername: "bot_a", botDisplayName: "Bot A" },
        },
        {
          assistantId: "assistant-b",
          botId: 222,
          identity: { botUsername: "bot_b", botDisplayName: "Bot B" },
        },
      ],
      enqueue: async (event) => {
        enqueued.push(event);
      },
    });
    const depsFor = (assistantId: string, botUsername: string, botId: number) => ({
      db,
      assistantId,
      identity: { botUsername, botDisplayName: botUsername },
      botId,
      botToken: `${botId}:fixture-token`,
      enqueue: async () => {},
    });
    const human = tgMessage({
      messageId: 1,
      chatId,
      group: true,
      text: "go on then",
      from: { id: 5001, username: "alice_example", firstName: "Alice" },
    });
    await processIncomingMessage(human, depsFor("assistant-a", "bot_a", 111));
    await processIncomingMessage(human, depsFor("assistant-b", "bot_b", 222));

    // A silent ack of background work: mirrored, but nothing to answer.
    await recordAssistantMessage(
      db,
      {
        chatId: String(chatId),
        assistantId: "assistant-a",
        telegramMessageId: 2,
        content: "looking into it…",
        replyToMessageId: 1,
        sentAt: new Date(),
        silent: true,
      },
      crossFeed,
    );
    // A generated image: its own message, with no words in it.
    await recordAssistantMessage(
      db,
      {
        chatId: String(chatId),
        assistantId: "assistant-a",
        telegramMessageId: 3,
        content: "",
        replyToMessageId: null,
        sentAt: new Date(),
      },
      crossFeed,
    );
    // A DM: one bot, one person — nobody else is listening.
    await recordAssistantMessage(
      db,
      {
        chatId: "7300",
        assistantId: "assistant-a",
        telegramMessageId: 4,
        content: "just between us",
        replyToMessageId: null,
        sentAt: new Date(),
      },
      crossFeed,
    );

    expect(await crossFeed.feed({
      chatId: String(chatId),
      assistantId: "assistant-a",
      telegramMessageId: 5,
      content: "and this one does travel",
      replyToMessageId: null,
      sentAt: new Date(),
    })).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].message.content).toBe("and this one does travel");
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
          botToken: "12345:fixture-token",
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
    const sends: Array<{
      chatId: string;
      text: string;
      replyTo: number | null;
      silent: boolean;
      linkable: number[];
    }> = [];
    let typingCalls = 0;
    let nextMessageId = 500;
    // Telegram silently drops a reply target it will not attach; the fake
    // flips to that behavior for the case below.
    let attachReplyTarget = true;
    const sender: TgSender = {
      sendMessage: async (chatId, text, opts) => {
        sends.push({
          chatId,
          text,
          replyTo: opts?.replyToMessageId ?? null,
          silent: opts?.silent ?? false,
          linkable: [...(opts?.linkableMessageIds ?? [])],
        });
        // Telegram echoes the reply target it actually attached.
        return {
          messageId: ++nextMessageId,
          replyToMessageId: attachReplyTarget ? (opts?.replyToMessageId ?? null) : null,
        };
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
      expect(sends[0]).toEqual({
        chatId: "-300",
        text: "the answer",
        replyTo: 11,
        silent: false,
        linkable: [],
      });

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

      // A silent delivery citing mirrored and invented ids: the silent flag
      // passes through and only the mirrored citation is whitelisted.
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d1b",
        occurredAt: new Date().toISOString(),
        correlationId: "-300:12",
        type: "reply.delivery",
        source: "tg",
        assistantId: "assistant-1",
        chatRef: "tg:chat:-300",
        replyToSourceMessageId: "11",
        text: "on it — context in #11 and #9999",
        silent: true,
      });
      await expect.poll(() => sends.length, { timeout: 10_000 }).toBe(2);
      expect(sends[1]).toMatchObject({ silent: true, linkable: [11] });

      // Telegram accepted the send but would not attach the reply target
      // (`allow_sending_without_reply`): the mirror must record the message
      // that is actually in the chat, not the pointer that was asked for.
      attachReplyTarget = false;
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-d1c",
        occurredAt: new Date().toISOString(),
        correlationId: "-300:13",
        type: "reply.delivery",
        source: "tg",
        assistantId: "assistant-1",
        chatRef: "tg:chat:-300",
        replyToSourceMessageId: "11",
        text: "standing on my own",
      });
      await expect.poll(() => sends.length, { timeout: 10_000 }).toBe(3);
      await expect
        .poll(
          async () => {
            const row = await pool.query(
              `SELECT reply_to_message_id FROM messages WHERE telegram_message_id = 503`,
            );
            return row.rows.length > 0 ? row.rows[0].reply_to_message_id : undefined;
          },
          { timeout: 10_000 },
        )
        .toBeNull();
      attachReplyTarget = true;

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
      expect(sends).toHaveLength(3);
    } finally {
      await publisher.close();
      await consumer.close();
    }
  });

  it("assistant.deleted drops exactly that assistant's connections", async () => {
    await pool.query(
      `INSERT INTO connections (id, assistant_id, bot_token, enabled) VALUES
         ('conn-a', 'assistant-doomed', 'token-a', true),
         ('conn-b', 'assistant-kept', 'token-b', true)`,
    );
    const dropped: string[] = [];
    const consumer = await startDeliveryConsumer({
      db,
      redisUrl,
      senderFor: () => ({
        sendMessage: async () => ({ messageId: 1, replyToMessageId: null }),
        sendTyping: () => {},
      }),
      // The seam the bot manager hangs off: rows deleted + pollers stopped.
      onAssistantDeleted: async (assistantId) => {
        const { deleteConnectionsByAssistant } = await import("./store");
        const rows = await deleteConnectionsByAssistant(db, assistantId);
        dropped.push(...rows.map((r) => r.id));
      },
    });
    const publisher = openPublisher(redisUrl);
    try {
      await publisher.publish(BUS_EVENTS_CHANNEL, {
        v: 1,
        eventId: "evt-ad1",
        occurredAt: new Date().toISOString(),
        correlationId: "assistant-doomed",
        type: "assistant.deleted",
        assistantId: "assistant-doomed",
      });
      await expect.poll(() => dropped, { timeout: 10_000 }).toEqual(["conn-a"]);
      const left = await pool.query(`SELECT id FROM connections ORDER BY id`);
      expect(left.rows.map((r) => r.id)).toEqual(["conn-b"]);
    } finally {
      await publisher.close();
      await consumer.close();
    }
  });
});
