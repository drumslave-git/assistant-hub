import { fileURLToPath } from "node:url";

import { serve, type ServerType } from "@hono/node-server";
import { TURN_META_KEY } from "@assistant-hub/contracts";
import { applyMigrations, startTestPostgres, type TestPostgres } from "@assistant-hub/db/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import { listThreadMessages } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

const TOKEN = "secret-token";
const USER_ID = "user-fixture";
const THREAD_ID = "thread-fixture";

/**
 * This app's own MCP server, over the transport it serves. It is tg's twin
 * with one deliberate difference: there is no reaction tool, because a web
 * thread has no reactions — a source does not offer an action it cannot take,
 * so the model never has to be told afterwards that it could not.
 */

describe("chat MCP server", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let server: ServerType;
  let url: string;
  let threadsChanged = 0;
  let firstMessageId: number;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const dbUrl = await pg.createDatabase("chat_mcp");
    await applyMigrations(dbUrl, MIGRATIONS);
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool, { schema });

    await pool.query(`INSERT INTO users (id, name, is_operator) VALUES ($1, 'Operator', true)`, [
      USER_ID,
    ]);
    await pool.query(
      `INSERT INTO threads (id, user_id, assistant_id, name) VALUES ($1, $2, 'assistant-1', 'Trip planning')`,
      [THREAD_ID, USER_ID],
    );
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO messages (thread_id, role, content, sent_at) VALUES ($1, 'user', 'where should we go?', now()) RETURNING id`,
      [THREAD_ID],
    );
    firstMessageId = Number(inserted.rows[0].id);

    const api = createApi({
      db,
      internalToken: TOKEN,
      onThreadsChanged: () => {
        threadsChanged += 1;
      },
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

  async function connect(headers: Record<string, string> = { "x-internal-token": TOKEN }) {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
    );
    return client;
  }

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

  const fireTurn = {
    source: "chat",
    chatId: THREAD_ID,
    assistantId: "assistant-1",
    deliveryKind: "send",
  };

  it("refuses a client without the shared secret", async () => {
    await expect(connect({})).rejects.toThrow();
  });

  it("offers the delivery tools and nothing that needs a platform it lacks", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["reply_to_message", "send_message"]);
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["text"]);
    }
    await client.close();
  });

  it("delivers into the thread and reports what it delivered", async () => {
    const client = await connect();
    const before = threadsChanged;

    const result = await call(client, "send_message", { text: "how about mountains" }, fireTurn);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.delivery).toMatchObject({
      ok: true,
      text: "how about mountains",
    });
    const messages = await listThreadMessages(db, THREAD_ID);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "how about mountains" });
    // The thread views wake up the same way an inbound message wakes them.
    expect(threadsChanged).toBeGreaterThan(before);
    await client.close();
  });

  it("attaches a reply to the message the turn is answering", async () => {
    const client = await connect();
    const result = await call(
      client,
      "reply_to_message",
      { text: "answering that" },
      { ...fireTurn, deliveryKind: "reply", replyToMessageId: firstMessageId },
    );

    expect(result.isError).toBeFalsy();
    const messages = await listThreadMessages(db, THREAD_ID);
    expect(messages.at(-1)).toMatchObject({
      content: "answering that",
      replyToMessageId: firstMessageId,
    });
    await client.close();
  });

  it("refuses the delivery the turn is not for, and a call with no turn", async () => {
    const client = await connect();
    const wrong = await call(client, "reply_to_message", { text: "hello" }, fireTurn);
    expect(wrong.isError).toBe(true);

    const unbound = (await client.callTool({
      name: "send_message",
      arguments: { text: "hello" },
    })) as unknown as { content: { text: string }[]; isError?: boolean };
    expect(unbound.isError).toBe(true);
    expect(unbound.content[0].text).toContain("without a conversation");
    await client.close();
  });

  it("reports a thread that is gone as a delivery that did not happen", async () => {
    const client = await connect();
    const result = await call(client, "send_message", { text: "anyone?" }, {
      ...fireTurn,
      chatId: "thread-that-never-existed",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.delivery).toMatchObject({ ok: false, messageId: null });
    await client.close();
  });
});
