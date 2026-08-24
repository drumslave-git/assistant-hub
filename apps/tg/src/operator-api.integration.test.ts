import { fileURLToPath } from "node:url";

import {
  operatorChatResponseSchema,
  operatorChatsResponseSchema,
  operatorConnectionResponseSchema,
  operatorConnectionsResponseSchema,
  operatorMessagesResponseSchema,
  operatorSourceSettingsResponseSchema,
  operatorUserResponseSchema,
  operatorUsersResponseSchema,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../store/schema";
import { createApi } from "./api";
import { insertMedia } from "./media/store";
import type { ConnectionStatus } from "./bot-manager";
import { appendMessage, recordBotReaction, upsertChatActivity, upsertUser } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../store/migrations", import.meta.url));

const TOKEN = "secret-token";
const HEADERS = { "x-internal-token": TOKEN, "content-type": "application/json" };
const GROUP_ID = "-2003";
const DM_ID = "7001";

describe("tg operator API", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let reconciled: Array<{ id: string; enabled: boolean }>;
  let removed: string[];
  let statuses: ConnectionStatus[];

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_operator");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });

    await upsertUser(db, {
      userId: DM_ID,
      username: "alice_example",
      firstName: "Alice",
      lastName: null,
    });
    await upsertChatActivity(db, {
      chatId: GROUP_ID,
      title: "Fixture Group",
      type: "supergroup",
      userId: DM_ID,
    });
    // Group traffic: a human message with media + a bot reply; DM traffic:
    // one human message.
    await appendMessage(db, {
      chatId: GROUP_ID,
      assistantId: null,
      telegramMessageId: 11,
      role: "user",
      userId: DM_ID,
      content: "look at this",
      replyToMessageId: null,
      sentAt: new Date("2026-08-20T10:00:00Z"),
      processed: true,
    });
    await insertMedia(db, {
      id: "media-op-1",
      chatId: GROUP_ID,
      telegramMessageId: 11,
      kind: "photo",
      fileId: "file-1",
      fileUniqueId: null,
      mimeType: "image/jpeg",
      visionHint: null,
      frames: [Buffer.from("jpeg").toString("base64")],
    });
    await appendMessage(db, {
      chatId: GROUP_ID,
      assistantId: null,
      telegramMessageId: 12,
      role: "assistant",
      userId: null,
      content: "a nice photo",
      replyToMessageId: 11,
      sentAt: new Date("2026-08-20T10:01:00Z"),
      processed: true,
    });
    await recordBotReaction(db, {
      chatId: GROUP_ID,
      telegramMessageId: 11,
      emoji: "👍",
      assistantId: null,
    });
    await appendMessage(db, {
      chatId: DM_ID,
      assistantId: null,
      telegramMessageId: 21,
      role: "user",
      userId: DM_ID,
      content: "hello there",
      replyToMessageId: null,
      sentAt: new Date("2026-08-21T09:00:00Z"),
      processed: true,
    });
    await pool.query(
      `INSERT INTO settings (id, owner_username, owner_user_id)
       VALUES ('singleton', 'owner_example', '9001')`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  function api() {
    reconciled = [];
    removed = [];
    return createApi({
      db,
      manager: {
        statuses: () => statuses ?? [],
        senderFor: () => {
          throw new Error("no sends in this test");
        },
        reconcileConnection: async (row) => {
          reconciled.push({ id: row.id, enabled: row.enabled });
        },
        removeConnection: async (id) => {
          removed.push(id);
        },
      },
      internalToken: TOKEN,
    });
  }

  it("lists users with labels and updates the curated fields", async () => {
    const app = api();
    const list = operatorUsersResponseSchema.parse(
      await (await app.request("/internal/users", { headers: HEADERS })).json(),
    );
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({
      id: DM_ID,
      username: "alice_example",
      label: "Alice (@alice_example)",
      aliases: [],
    });

    const patched = operatorUserResponseSchema.parse(
      await (
        await app.request(`/internal/users/${DM_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ aliases: ["Al", "Alya"] }),
        })
      ).json(),
    );
    expect(patched.user!.aliases).toEqual(["Al", "Alya"]);

    const language = operatorUserResponseSchema.parse(
      await (
        await app.request(`/internal/users/${DM_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ language: "Ukrainian" }),
        })
      ).json(),
    );
    expect(language.user!.language).toBe("Ukrainian");

    const missing = await app.request("/internal/users/999999", {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ language: null }),
    });
    expect(missing.status).toBe(404);
  });

  it("lists chats (mirror aggregates + group metadata) and updates group fields", async () => {
    const app = api();
    const list = operatorChatsResponseSchema.parse(
      await (await app.request("/internal/chats", { headers: HEADERS })).json(),
    );
    expect(list.chats).toHaveLength(2);
    // Newest activity first: the DM message is more recent.
    expect(list.chats[0]).toMatchObject({ id: DM_ID, kind: "direct", messageCount: 1 });
    expect(list.chats[1]).toMatchObject({
      id: GROUP_ID,
      kind: "group",
      title: "Fixture Group",
      type: "supergroup",
      messageCount: 2,
    });

    const patched = operatorChatResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${GROUP_ID}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ notes: "the fixture crowd" }),
        })
      ).json(),
    );
    expect(patched.chat).toMatchObject({ notes: "the fixture crowd", messageCount: 2 });

    // A DM has no chat row to curate.
    const missing = await app.request(`/internal/chats/${DM_ID}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ notes: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("serves a chat's full mirror with media annotations and reactions", async () => {
    const app = api();
    const body = operatorMessagesResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${GROUP_ID}/messages`, { headers: HEADERS })
      ).json(),
    );
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      sourceMessageId: "11",
      role: "user",
      userId: DM_ID,
      content: "look at this",
      botReaction: "👍",
      media: { kind: "photo", status: "pending", description: null },
    });
    expect(body.messages[1]).toMatchObject({
      sourceMessageId: "12",
      role: "assistant",
      replyToSourceMessageId: "11",
      media: null,
    });
  });

  it("runs the connection lifecycle: create reconciles, patch reconciles, delete removes", async () => {
    const app = api();
    const created = operatorConnectionResponseSchema.parse(
      await (
        await app.request("/internal/connections", {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ assistantId: "assistant-1", botToken: "12345:fixture-token" }),
        })
      ).json(),
    );
    const id = created.connection!.id;
    expect(created.connection).toMatchObject({
      assistantId: "assistant-1",
      enabled: true,
      botTokenHint: "oken",
    });
    expect(reconciled).toEqual([{ id, enabled: true }]);

    // One bot per assistant.
    const duplicate = await app.request("/internal/connections", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ assistantId: "assistant-1", botToken: "999:other" }),
    });
    expect(duplicate.status).toBe(409);

    // The live poller state joins the listing.
    statuses = [
      {
        connectionId: id,
        assistantId: "assistant-1",
        state: "running",
        username: "fixture_bot",
        since: new Date().toISOString(),
        error: null,
      },
    ];
    const list = operatorConnectionsResponseSchema.parse(
      await (await app.request("/internal/connections", { headers: HEADERS })).json(),
    );
    expect(list.connections[0].status).toMatchObject({
      state: "running",
      username: "fixture_bot",
    });
    statuses = [];

    const disabled = operatorConnectionResponseSchema.parse(
      await (
        await app.request(`/internal/connections/${id}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ enabled: false }),
        })
      ).json(),
    );
    expect(disabled.connection!.enabled).toBe(false);
    expect(reconciled).toContainEqual({ id, enabled: false });

    const deleted = await app.request(`/internal/connections/${id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(deleted.status).toBe(200);
    expect(removed).toEqual([id]);
    const after = operatorConnectionsResponseSchema.parse(
      await (await app.request("/internal/connections", { headers: HEADERS })).json(),
    );
    expect(after.connections).toEqual([]);
  });

  it("carries two assistants' connections independently, each with its own poller state", async () => {
    const app = api();
    const create = async (assistantId: string, botToken: string) =>
      operatorConnectionResponseSchema.parse(
        await (
          await app.request("/internal/connections", {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({ assistantId, botToken }),
          })
        ).json(),
      ).connection!;
    const first = await create("assistant-a", "111:token-aaaa");
    const second = await create("assistant-b", "222:token-bbbb");
    // Both pollers were asked to start — one per connection.
    expect(reconciled).toEqual([
      { id: first.id, enabled: true },
      { id: second.id, enabled: true },
    ]);

    // Each row joins ITS poller's live state: one bot up, the other down.
    statuses = [
      {
        connectionId: first.id,
        assistantId: "assistant-a",
        state: "running",
        username: "bot_a",
        since: new Date().toISOString(),
        error: null,
      },
      {
        connectionId: second.id,
        assistantId: "assistant-b",
        state: "error",
        username: null,
        since: null,
        error: "401 unauthorized",
      },
    ];
    const list = operatorConnectionsResponseSchema.parse(
      await (await app.request("/internal/connections", { headers: HEADERS })).json(),
    );
    const byAssistant = new Map(list.connections.map((c) => [c.assistantId, c]));
    expect(byAssistant.get("assistant-a")!.status).toMatchObject({
      state: "running",
      username: "bot_a",
    });
    expect(byAssistant.get("assistant-b")!.status).toMatchObject({
      state: "error",
      error: "401 unauthorized",
    });
    statuses = [];

    // Stopping one leaves the other's desired state untouched.
    await app.request(`/internal/connections/${first.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    const after = operatorConnectionsResponseSchema.parse(
      await (await app.request("/internal/connections", { headers: HEADERS })).json(),
    );
    expect(
      new Map(after.connections.map((c) => [c.assistantId, c.enabled])),
    ).toEqual(new Map([["assistant-a", false], ["assistant-b", true]]));

    for (const id of [first.id, second.id]) {
      await app.request(`/internal/connections/${id}`, { method: "DELETE", headers: HEADERS });
    }
  });

  it("serves the owner settings; a new owner resets the resolved id", async () => {
    const app = api();
    const current = operatorSourceSettingsResponseSchema.parse(
      await (await app.request("/internal/settings", { headers: HEADERS })).json(),
    );
    expect(current.settings).toEqual({ ownerUsername: "owner_example", ownerUserId: "9001" });

    // Same owner re-saved (normalized spelling): the resolved id survives.
    const same = operatorSourceSettingsResponseSchema.parse(
      await (
        await app.request("/internal/settings", {
          method: "PUT",
          headers: HEADERS,
          body: JSON.stringify({ ownerUsername: "@Owner_Example" }),
        })
      ).json(),
    );
    expect(same.settings).toEqual({ ownerUsername: "owner_example", ownerUserId: "9001" });

    // A different owner must be re-resolved on their first message.
    const changed = operatorSourceSettingsResponseSchema.parse(
      await (
        await app.request("/internal/settings", {
          method: "PUT",
          headers: HEADERS,
          body: JSON.stringify({ ownerUsername: "new_owner_example" }),
        })
      ).json(),
    );
    expect(changed.settings).toEqual({
      ownerUsername: "new_owner_example",
      ownerUserId: null,
    });
  });
});
