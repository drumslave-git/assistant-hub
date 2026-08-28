import { fileURLToPath } from "node:url";

import { serve, type ServerType } from "@hono/node-server";
import { TURN_META_KEY } from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import type { TgOutbound } from "./outbound";
import { appendMessage, getMessageByTelegramId } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

/** A supergroup id with a `-100` prefix, as a real group has. */
const CHAT_ID = "-1001234567890";
const TOKEN = "secret-token";

/**
 * This app's own MCP server, over the real Streamable HTTP transport it
 * serves (Phase 5). The reaction tool used to live in the core and reach
 * Telegram through this app's REST API; now the tool IS here, and what the
 * core sends is the turn — as `_meta`, never as arguments.
 *
 * Everything below therefore goes through an actual MCP client: the
 * Hono-to-Node bridging, the token guard, the turn binding, and the mirror
 * gate that keeps the bot from reacting to ids it guessed or to itself.
 */

describe("tg MCP server", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let server: ServerType;
  let url: string;
  const calls: { setReaction: unknown[]; sendMessage: { chatId: string; text: string; opts?: { replyToMessageId?: number | null } }[] } = {
    setReaction: [],
    sendMessage: [],
  };
  let reactionError: Error | null = null;
  let sendError: Error | null = null;
  let nextMessageId = 900;

  const sender = {
    async setReaction(chatId: string, messageId: number, emoji: string | null, opts?: { big?: boolean }) {
      if (reactionError) throw reactionError;
      calls.setReaction.push({ chatId, messageId, emoji, opts });
    },
    async sendMessage(
      chatId: string,
      text: string,
      opts?: { replyToMessageId?: number | null; threadId?: number | null },
    ) {
      if (sendError) throw sendError;
      calls.sendMessage.push({ chatId, text, opts });
      return { messageId: ++nextMessageId, replyToMessageId: opts?.replyToMessageId ?? null };
    },
  } as unknown as TgOutbound;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const dbUrl = await pg.createDatabase("tg_mcp");
    await applyMigrations(dbUrl, MIGRATIONS);
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool, { schema });

    // Prior conversation: a person's message (#21) and the bot's own (#22).
    await appendMessage(db, {
      chatId: CHAT_ID,
      assistantId: null,
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
      assistantId: null,
      telegramMessageId: 22,
      role: "assistant",
      userId: null,
      content: "the earlier answer",
      replyToMessageId: 21,
      sentAt: new Date(),
      processed: true,
    });

    const api = createApi({
      db,
      manager: {
        statuses: () => [],
        senderFor: () => sender,
        reconcileConnection: async () => undefined,
        removeConnection: async () => undefined,
      },
      internalToken: TOKEN,
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(info.port),
      );
    });
    url = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    server?.close();
    await pool?.end();
    await pg?.stop();
  });

  /** An MCP client with the shared secret, as the core connects. */
  async function connect(headers: Record<string, string> = { "x-internal-token": TOKEN }) {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  }

  /** One reaction call, bound to a turn the way the core binds one. */
  async function react(
    client: Client,
    args: Record<string, unknown>,
    meta: Record<string, unknown> = { source: "tg", chatId: CHAT_ID, assistantId: null },
  ) {
    const result = (await client.callTool({
      name: "set_message_reaction",
      arguments: args,
      _meta: { [TURN_META_KEY]: meta },
    })) as unknown as {
      content: { text: string }[];
      structuredContent: { ok: boolean; emoji: string | null };
      isError?: boolean;
    };
    return result;
  }

  /** One tool call, bound to a turn the way the core binds one. */
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) {
    return (await client.callTool({
      name,
      arguments: args,
      _meta: { [TURN_META_KEY]: meta },
    })) as unknown as {
      content: { text: string }[];
      structuredContent?: { delivery?: { ok: boolean; messageId: number | null; text: string } };
      isError?: boolean;
    };
  }

  it("refuses a client without the shared secret", async () => {
    await expect(connect({})).rejects.toThrow();
  });

  it("offers the reaction tool with the emoji set in its description", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "reply_to_message",
      "send_message",
      "set_message_reaction",
    ]);
    const reaction = tools.find((tool) => tool.name === "set_message_reaction")!;
    // The model picks WHAT to react with; the chat it reacts in is not a field.
    expect(Object.keys(reaction.inputSchema.properties ?? {}).sort()).toEqual([
      "big",
      "emoji",
      "message_id",
    ]);
    // The allowed set travels in the field's own description, where the model
    // reads it while choosing a value.
    const emojiField = (reaction.inputSchema.properties as Record<string, { description: string }>)
      .emoji;
    expect(emojiField.description).toContain("👍");
    // A delivery tool takes words and nothing else: no chat, no target.
    for (const name of ["reply_to_message", "send_message"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["text"]);
    }
    await client.close();
  });

  it("reacts to a person's message and remembers it on the mirror", async () => {
    const client = await connect();
    const result = await react(client, { message_id: 21, emoji: "👍", big: true });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, emoji: "👍" });
    expect(calls.setReaction[0]).toMatchObject({
      chatId: CHAT_ID,
      messageId: 21,
      emoji: "👍",
      opts: { big: true },
    });
    const row = await getMessageByTelegramId(db, CHAT_ID, 21, null);
    expect(row!.botReaction).toBe("👍");
    await client.close();
  });

  it("gates the platform call on the mirror", async () => {
    const client = await connect();
    calls.setReaction.length = 0;

    const guessed = await react(client, { message_id: 9999, emoji: "👍" });
    expect(guessed.isError).toBe(true);
    expect(guessed.content[0].text).toContain("No message #9999");

    const own = await react(client, { message_id: 22, emoji: "👍" });
    expect(own.isError).toBe(true);
    expect(own.content[0].text).toContain("is your own");

    expect(calls.setReaction).toHaveLength(0);
    await client.close();
  });

  it("normalizes a spelling Telegram rejects, and refuses one it has no reaction for", async () => {
    const client = await connect();
    calls.setReaction.length = 0;

    // The heart written with a presentation selector, as a model writes it.
    const heart = await react(client, { message_id: 21, emoji: "❤\u{FE0F}" });
    expect(heart.isError).toBeFalsy();
    expect(calls.setReaction[0]).toMatchObject({ emoji: "❤" });

    const nonsense = await react(client, { message_id: 21, emoji: "🦆" });
    expect(nonsense.isError).toBe(true);
    expect(nonsense.content[0].text).toContain("no \"🦆\" reaction");
    await client.close();
  });

  it("relays a platform refusal instead of claiming it reacted", async () => {
    const client = await connect();
    reactionError = new Error("REACTION_INVALID");
    const result = await react(client, { message_id: 21, emoji: "🕊" });
    reactionError = null;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("REACTION_INVALID");
    expect(result.content[0].text).toContain("Do not claim you reacted");
    await client.close();
  });


  describe("delivery tools", () => {
    const replyTurn = {
      source: "tg",
      chatId: CHAT_ID,
      assistantId: null,
      deliveryKind: "reply",
      replyToMessageId: 21,
    };
    const fireTurn = { source: "tg", chatId: CHAT_ID, assistantId: null, deliveryKind: "send" };

    it("attaches a reply to the message the turn is answering", async () => {
      const client = await connect();
      calls.sendMessage.length = 0;

      const result = await call(client, "reply_to_message", { text: "here you go" }, replyTurn);

      expect(result.isError).toBeFalsy();
      expect(calls.sendMessage[0]).toMatchObject({
        chatId: CHAT_ID,
        text: "here you go",
        opts: { replyToMessageId: 21 },
      });
      // The core learns what was delivered from the result, not from the name.
      expect(result.structuredContent?.delivery).toMatchObject({
        ok: true,
        text: "here you go",
      });
      await client.close();
    });

    it("sends a fire standalone, with nothing to attach to", async () => {
      const client = await connect();
      calls.sendMessage.length = 0;

      const result = await call(client, "send_message", { text: "the daily nudge" }, fireTurn);

      expect(result.isError).toBeFalsy();
      expect(calls.sendMessage[0]).toMatchObject({ opts: { replyToMessageId: null } });
      await client.close();
    });

    it("refuses the delivery the turn is not for", async () => {
      const client = await connect();
      calls.sendMessage.length = 0;

      // A stale offer cannot smuggle a send into the wrong kind of turn: the
      // turn kind travels with the call and is checked here too.
      const wrongSend = await call(client, "send_message", { text: "hello" }, replyTurn);
      expect(wrongSend.isError).toBe(true);
      expect(wrongSend.content[0].text).toContain("timed task");

      const wrongReply = await call(client, "reply_to_message", { text: "hello" }, fireTurn);
      expect(wrongReply.isError).toBe(true);
      expect(wrongReply.content[0].text).toContain("triggered by a message");

      // An ordinary reply turn delivers its own text and may do neither.
      const ordinary = await call(client, "send_message", { text: "hello" }, {
        source: "tg",
        chatId: CHAT_ID,
        assistantId: null,
      });
      expect(ordinary.isError).toBe(true);

      expect(calls.sendMessage).toHaveLength(0);
      await client.close();
    });

    it("reports a refused send as a delivery that did not happen", async () => {
      const client = await connect();
      sendError = new Error("bot was blocked by the user");
      const result = await call(client, "send_message", { text: "anyone there?" }, fireTurn);
      sendError = null;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("blocked");
      // Reported, not silent: the fire counts an attempt that reached nobody.
      expect(result.structuredContent?.delivery).toMatchObject({
        ok: false,
        messageId: null,
        text: "anyone there?",
      });
      await client.close();
    });

    it("mirrors what it delivered, so the next turn remembers saying it", async () => {
      const client = await connect();
      const result = await call(client, "send_message", { text: "remembered" }, fireTurn);
      const messageId = result.structuredContent!.delivery!.messageId!;

      const row = await getMessageByTelegramId(db, CHAT_ID, messageId, null);
      expect(row).toMatchObject({ role: "assistant", content: "remembered" });
      await client.close();
    });
  });

  it("refuses a call that carries no turn", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "set_message_reaction",
      arguments: { message_id: 21, emoji: "👍" },
    })) as unknown as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("without a conversation");
    await client.close();
  });
});
