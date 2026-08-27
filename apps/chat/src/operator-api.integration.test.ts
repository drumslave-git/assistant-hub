import { fileURLToPath } from "node:url";

import {
  operatorChatMembersResponseSchema,
  operatorChatResponseSchema,
  operatorChatsResponseSchema,
  operatorMessageResponseSchema,
  operatorMessagesResponseSchema,
  operatorUserResponseSchema,
  operatorUsersResponseSchema,
} from "@assistant-hub/contracts";
import { applyMigrations, startTestPostgres, type TestPostgres } from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

const TOKEN = "secret-token";
const HEADERS = { "x-internal-token": TOKEN, "content-type": "application/json" };
const USER_ID = "user-fixture";
const THREAD_ID = "thread-fixture";
const EMPTY_THREAD_ID = "thread-empty";

/**
 * The chat app's half of the shared operator listing contract: the dashboard
 * aggregates every source through these endpoints, so what matters here is
 * that this app answers the contract's shapes for ITS entities — a thread is
 * a `direct` chat, its roster is its owner, and the curated fields are
 * writable.
 */
describe("chat operator API", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let messageIds: number[];

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("chat_operator");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });

    await pool.query(`INSERT INTO users (id, name, is_operator) VALUES ($1, 'Operator', true)`, [
      USER_ID,
    ]);
    await pool.query(
      `INSERT INTO threads (id, user_id, assistant_id, name, created_at)
       VALUES ($1, $2, 'assistant-fixture', 'Trip planning', '2026-08-25T08:00:00Z')`,
      [THREAD_ID, USER_ID],
    );
    await pool.query(
      `INSERT INTO threads (id, user_id, assistant_id, name, created_at)
       VALUES ($1, $2, 'assistant-fixture', 'Nothing said yet', '2026-08-26T08:00:00Z')`,
      [EMPTY_THREAD_ID, USER_ID],
    );
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO messages (thread_id, role, content, sent_at)
       VALUES ($1, 'user', 'where should we go?', '2026-08-25T09:00:00Z'),
              ($1, 'assistant', 'somewhere with mountains', '2026-08-25T09:00:05Z')
       RETURNING id`,
      [THREAD_ID],
    );
    messageIds = inserted.rows.map((row) => Number(row.id));
    await pool.query(
      `UPDATE messages SET reply_to_message_id = $1 WHERE id = $2`,
      [messageIds[0], messageIds[1]],
    );
    await pool.query(
      `INSERT INTO media (id, message_id, kind, mime_type, description, status)
       VALUES ('media-fixture', $1, 'image', 'image/jpeg', 'a mountain range', 'described')`,
      [messageIds[0]],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  const api = () => createApi({ db, internalToken: TOKEN });

  it("refuses anything without the internal token", async () => {
    const res = await api().request("/internal/users");
    expect(res.status).toBe(401);
  });

  it("reports health from the database, not from configuration", async () => {
    const res = await api().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lists users and updates the curated fields", async () => {
    const app = api();
    const list = operatorUsersResponseSchema.parse(
      await (await app.request("/internal/users", { headers: HEADERS })).json(),
    );
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({
      id: USER_ID,
      label: "Operator",
      username: null,
      aliases: [],
      language: null,
    });

    const patched = operatorUserResponseSchema.parse(
      await (
        await app.request(`/internal/users/${USER_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ aliases: ["Chief"] }),
        })
      ).json(),
    );
    expect(patched.user!.aliases).toEqual(["Chief"]);

    const language = operatorUserResponseSchema.parse(
      await (
        await app.request(`/internal/users/${USER_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ language: "Ukrainian" }),
        })
      ).json(),
    );
    expect(language.user!.language).toBe("Ukrainian");

    const missing = await app.request("/internal/users/nobody", { headers: HEADERS });
    expect(missing.status).toBe(404);
  });

  it("lists threads as direct chats, most recent first", async () => {
    const list = operatorChatsResponseSchema.parse(
      await (await api().request("/internal/chats", { headers: HEADERS })).json(),
    );
    // A thread with nothing said in it yet still lists, ordered by when it was
    // created — a thread you just started belongs at the top, not nowhere.
    expect(list.chats.map((chat) => chat.id)).toEqual([EMPTY_THREAD_ID, THREAD_ID]);
    expect(list.chats[0]).toMatchObject({
      title: "Nothing said yet",
      messageCount: 0,
      lastMessageAt: null,
    });
    expect(list.chats[1]).toMatchObject({
      kind: "direct",
      title: "Trip planning",
      messageCount: 2,
      memberCount: 1,
      lastMessageAt: "2026-08-25T09:00:05.000Z",
    });
  });

  it("serves one thread, its roster, and its curated fields", async () => {
    const app = api();
    const one = operatorChatResponseSchema.parse(
      await (await app.request(`/internal/chats/${THREAD_ID}`, { headers: HEADERS })).json(),
    );
    expect(one.chat).toMatchObject({ id: THREAD_ID, title: "Trip planning" });

    const members = operatorChatMembersResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${THREAD_ID}/members`, { headers: HEADERS })
      ).json(),
    );
    expect(members.members).toHaveLength(1);
    expect(members.members[0]).toMatchObject({
      id: USER_ID,
      memberSinceAt: "2026-08-25T08:00:00.000Z",
      lastSeenAt: "2026-08-25T09:00:00.000Z",
    });

    const notes = operatorChatResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${THREAD_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ notes: "planning the autumn trip" }),
        })
      ).json(),
    );
    expect(notes.chat).toMatchObject({ notes: "planning the autumn trip" });

    const unknown = await app.request("/internal/chats/thread-nope", { headers: HEADERS });
    expect(unknown.status).toBe(404);
  });

  it("serves the transcript with sender, reply target and media", async () => {
    const app = api();
    const list = operatorMessagesResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${THREAD_ID}/messages`, { headers: HEADERS })
      ).json(),
    );
    expect(list.messages).toHaveLength(2);
    expect(list.messages[0]).toMatchObject({
      sourceMessageId: String(messageIds[0]),
      role: "user",
      // Every human line in a thread is the thread's owner.
      userId: USER_ID,
      content: "where should we go?",
      media: { kind: "image", status: "described", description: "a mountain range" },
    });
    expect(list.messages[1]).toMatchObject({
      role: "assistant",
      userId: null,
      replyToSourceMessageId: String(messageIds[0]),
      media: null,
    });

    const one = operatorMessageResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${THREAD_ID}/messages/${messageIds[1]}`, {
          headers: HEADERS,
        })
      ).json(),
    );
    expect(one.message).toMatchObject({ content: "somewhere with mountains" });

    const missing = await app.request(`/internal/chats/${THREAD_ID}/messages/999999`, {
      headers: HEADERS,
    });
    expect(missing.status).toBe(404);
  });
});
