import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  InboundMessageEvent,
  MessageDeliveredEvent,
  TransportMessageEvent,
} from "@assistant-hub-swarm/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub-swarm/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoreDb } from "@/server/store/db";

import * as storeSchema from "../../store/schema";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/**
 * The ingest stage end to end against a real store: a transport message
 * becomes mirror rows + presence + turn events (fanned out by core-owned
 * presence), a delivered report becomes the assistant's mirror row and the
 * cross-fed turns, edits and bot reactions land on the row — the behaviors
 * the tg app's runtime suite proved before the de-storing.
 */

const { enqueued, holder } = vi.hoisted(() => ({
  enqueued: [] as InboundMessageEvent[],
  holder: { db: null as unknown },
}));

vi.mock("@/server/turn/enqueue", () => ({
  enqueueInboundEvent: async (event: InboundMessageEvent) => {
    enqueued.push(event);
  },
}));

vi.mock("@/server/store/db", () => ({
  getStoreDb: () => holder.db,
  getStorePool: () => {
    throw new Error("not used in this suite");
  },
  closeStorePool: async () => {},
}));

const { processTransportUpdate } = await import("./consumer");
const repository = await import("@/server/source-store/repository");

let pg: TestPostgres;
let pool: Pool;
let db: StoreDb;

beforeAll(async () => {
  pg = await startTestPostgres();
  const url = await pg.createDatabase("ingest");
  await applyMigrations(url, STORE_MIGRATIONS);
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema: storeSchema });
  holder.db = db;
  // The ingest accepts updates only from a registered transport; the suite
  // speaks as "tg", so register it once (the per-test truncate spares it).
  await db.insert(storeSchema.transports).values({
    id: "tg",
    name: "Telegram",
    baseUrl: "http://tg:3210",
    mcpPath: "/mcp",
  });
});

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

beforeEach(async () => {
  enqueued.length = 0;
  await pool.query(
    `TRUNCATE source_users, source_chats, source_chat_members, source_chat_assistants,
             source_messages, source_message_search, source_media, source_media_blobs,
             source_feedbacks, source_summaries RESTART IDENTITY CASCADE`,
  );
});

const GROUP = "-100200";
const anna = {
  assistantId: "anna",
  identity: { botUsername: "anna_bot", botDisplayName: "Anna" },
};
const igor = {
  assistantId: "igor",
  identity: { botUsername: "igor_bot", botDisplayName: "Igor" },
};

function messageEvent(overrides: {
  sourceMessageId?: string;
  content?: string;
  chatId?: string;
  kind?: "direct" | "group";
  receivedBy?: string;
  receivers?: TransportMessageEvent["receivers"];
  media?: TransportMessageEvent["media"];
  replyTo?: NonNullable<TransportMessageEvent["message"]["replyTo"]>;
} = {}): TransportMessageEvent {
  const chatId = overrides.chatId ?? GROUP;
  const kind = overrides.kind ?? "group";
  const sourceMessageId = overrides.sourceMessageId ?? "42";
  const receivedBy = overrides.receivedBy ?? "anna";
  return {
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: `${chatId}:${sourceMessageId}`,
    type: "transport.message",
    source: "tg",
    receivedBy,
    chat: { id: chatId, kind, title: kind === "group" ? "The group" : null, type: null },
    sender: {
      userId: "7",
      username: "sam",
      firstName: "Sam",
      lastName: null,
    },
    message: {
      sourceMessageId,
      content: overrides.content ?? "hello there",
      sentAt: new Date().toISOString(),
      threadId: null,
      replyTo: overrides.replyTo ?? null,
    },
    media: overrides.media ?? null,
    receivers: overrides.receivers ?? [
      {
        assistantId: "anna",
        identity: anna.identity,
        addressing: { addressed: false, needsAnalyzer: true, source: null, reason: null },
      },
      {
        assistantId: "igor",
        identity: igor.identity,
        addressing: { addressed: true, source: "mention", needsAnalyzer: false, reason: null },
      },
    ],
    dedupeKey: kind === "group" ? `${chatId}:${sourceMessageId}` : `${chatId}:${receivedBy}:${sourceMessageId}`,
  };
}

function deliveredEvent(overrides: {
  sourceMessageId?: string;
  content?: string;
  assistantId?: string | null;
  replyToSourceMessageId?: string | null;
  silent?: boolean;
} = {}): MessageDeliveredEvent {
  const sourceMessageId = overrides.sourceMessageId ?? "60";
  return {
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: `${GROUP}:${sourceMessageId}`,
    type: "message.delivered",
    source: "tg",
    chat: { id: GROUP, kind: "group" },
    assistantId: overrides.assistantId === undefined ? "anna" : overrides.assistantId,
    sourceMessageId,
    dedupeKey: `${GROUP}:${sourceMessageId}`,
    content: overrides.content ?? "anna's reply",
    replyToSourceMessageId: overrides.replyToSourceMessageId ?? null,
    sentAt: new Date().toISOString(),
    threadId: null,
    silent: overrides.silent ?? false,
    image: null,
    running: [
      { assistantId: "anna", botId: "1001", identity: anna.identity },
      { assistantId: "igor", botId: "1002", identity: igor.identity },
    ],
  };
}

describe("transport.message", () => {
  it("persists the message and fans turns out by presence", async () => {
    // Igor is present in the group from earlier activity; anna receives.
    await repository.stampAssistantPresence(
      { source: "tg", chatId: GROUP, assistantId: "igor" },
      db,
    );
    await processTransportUpdate(messageEvent());

    // Mirror row + directory + presence of the receiver.
    const rows = await repository.listSourceChatMessages("tg", GROUP, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user", userId: "7", processed: false });
    expect(await repository.listChatAssistants("tg", GROUP, db)).toEqual(
      expect.arrayContaining(["anna", "igor"]),
    );

    // Two turns — the receiver (defensively) and the present listener — each
    // with its own verdict, correlation, and composed context.
    expect(enqueued).toHaveLength(2);
    const byAssistant = new Map(enqueued.map((e) => [e.assistantId, e]));
    expect(byAssistant.get("igor")?.addressing).toMatchObject({ addressed: true });
    expect(byAssistant.get("anna")?.addressing).toMatchObject({ needsAnalyzer: true });
    expect(byAssistant.get("anna")?.correlationId).toBe(`${GROUP}:42:anna`);
    expect(byAssistant.get("anna")?.chat).toMatchObject({
      ref: `tg:chat:${GROUP}`,
      kind: "group",
      title: "The group",
    });
    expect(byAssistant.get("anna")?.sender).toMatchObject({ ref: "tg:user:7", label: expect.stringContaining("Sam") });
  });

  it("consumes a self-link code instead of opening a turn", async () => {
    // A minted code waiting for redemption (Phase 8 self-link).
    await pool.query(
      `INSERT INTO accounts (id, username, password_hash, role, session_secret)
       VALUES ('acct-1', 'sam-web', 'scrypt:x', 'user', 's')`,
    );
    await pool.query(
      `INSERT INTO account_link_codes (code, account_id, expires_at)
       VALUES ('link-abcd2345', 'acct-1', now() + interval '10 minutes')`,
    );

    await processTransportUpdate(messageEvent({ content: "link-abcd2345" }));

    // Mirrored (the transcript keeps what was said) but consumed: no turn,
    // hold released, and the identity now shares a link with the account.
    expect(enqueued).toHaveLength(0);
    const rows = await repository.listSourceChatMessages("tg", GROUP, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].processed).toBe(true);
    const linked = await pool.query(
      `SELECT count(*)::int AS n FROM person_link_members
       WHERE user_ref IN ('tg:user:7', 'chat:user:acct-1')`,
    );
    expect(linked.rows[0].n).toBe(2);
  });

  it("is idempotent on the dedupe key", async () => {
    await processTransportUpdate(messageEvent());
    const turns = enqueued.length;
    await processTransportUpdate(messageEvent());
    expect(enqueued).toHaveLength(turns);
    expect(await repository.listSourceChatMessages("tg", GROUP, db)).toHaveLength(1);
  });

  it("stores event media and references it on the turn", async () => {
    await processTransportUpdate(
      messageEvent({
        content: "what is this?",
        media: {
          kind: "photo",
          fileId: "file-1",
          fileUniqueId: "uniq-1",
          mimeType: "image/jpeg",
          visionHint: null,
          frames: [Buffer.from("jpeg").toString("base64")],
          unavailable: false,
        },
        receivers: [
          {
            assistantId: "anna",
            identity: anna.identity,
            addressing: { addressed: true, source: "mention", needsAnalyzer: false, reason: null },
          },
        ],
      }),
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].message.media).toHaveLength(1);
    expect(enqueued[0].message.media[0]).toMatchObject({ kind: "photo", status: "pending" });
  });

  it("composes the history window from earlier mirrored traffic", async () => {
    await processTransportUpdate(messageEvent({ sourceMessageId: "10", content: "first" }));
    enqueued.length = 0;
    await processTransportUpdate(messageEvent({ sourceMessageId: "11", content: "second" }));
    const turn = enqueued[0];
    expect(turn.context.history.map((line) => line.content)).toEqual(["first"]);
    expect(turn.context.participants.map((p) => p.ref)).toEqual(["tg:user:7"]);
  });
});

describe("message.delivered", () => {
  it("mirrors the reply and cross-feeds it to the other present assistants", async () => {
    await repository.stampAssistantPresence(
      { source: "tg", chatId: GROUP, assistantId: "anna" },
      db,
    );
    await repository.stampAssistantPresence(
      { source: "tg", chatId: GROUP, assistantId: "igor" },
      db,
    );
    await processTransportUpdate(deliveredEvent({ content: "igor, what do you think?" }));
    // Detached cross-feed: wait for the enqueue.
    await vi.waitFor(() => {
      expect(enqueued).toHaveLength(1);
    });

    const rows = await repository.listSourceChatMessages("tg", GROUP, db);
    expect(rows[0]).toMatchObject({ role: "assistant", assistantId: "anna" });

    const fed = enqueued[0];
    expect(fed).toMatchObject({
      assistantId: "igor",
      authoredByAssistantId: "anna",
      source: "tg",
    });
    expect(fed.sender).toMatchObject({ ref: "tg:user:1001", label: "Anna" });
    expect(fed.addressing).toMatchObject({ needsAnalyzer: true });
  });

  it("never cross-feeds silent sends, and re-reports change nothing", async () => {
    await repository.stampAssistantPresence(
      { source: "tg", chatId: GROUP, assistantId: "igor" },
      db,
    );
    await processTransportUpdate(deliveredEvent({ silent: true }));
    await processTransportUpdate(deliveredEvent({ silent: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueued).toHaveLength(0);
    expect(await repository.listSourceChatMessages("tg", GROUP, db)).toHaveLength(1);
  });
});

describe("edits + bot reactions", () => {
  it("applies an edit and a bot-reaction badge to the mirror row", async () => {
    await processTransportUpdate(messageEvent({ sourceMessageId: "80", content: "typo'd" }));
    await processTransportUpdate({
      v: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: `${GROUP}:80`,
      type: "transport.edited",
      source: "tg",
      chat: { id: GROUP, kind: "group" },
      assistantId: "anna",
      sourceMessageId: "80",
      content: "fixed",
      editedAt: new Date().toISOString(),
    });
    await processTransportUpdate({
      v: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: `${GROUP}:80`,
      type: "transport.bot-reaction",
      source: "tg",
      chat: { id: GROUP, kind: "group" },
      assistantId: "anna",
      sourceMessageId: "80",
      emoji: "👍",
    });
    const row = await repository.getSourceMessage(
      { source: "tg", chatId: GROUP, assistantId: null, direct: false },
      "80",
      db,
    );
    expect(row).toMatchObject({ content: "fixed", botReaction: "👍" });
    expect(row?.editedAt).not.toBeNull();
  });
});

describe("transport.presence", () => {
  it("stamps presence from a suppressed duplicate receipt", async () => {
    await processTransportUpdate({
      v: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: `presence:${GROUP}:igor`,
      type: "transport.presence",
      source: "tg",
      chatId: GROUP,
      assistantId: "igor",
    });
    expect(await repository.listChatAssistants("tg", GROUP, db)).toEqual(["igor"]);
  });
});
