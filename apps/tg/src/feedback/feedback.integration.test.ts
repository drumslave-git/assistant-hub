import { fileURLToPath } from "node:url";

import {
  feedbackRecordedEventSchema,
  internalFeedbackResponseSchema,
  internalFeedbacksResponseSchema,
  operatorMessageResponseSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import type { MessageReactionUpdated } from "@grammyjs/types";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../store/schema";
import { createApi } from "../api";
import { processIncomingMessage } from "../inbound";
import { appendMessage, getMessageByTelegramId, upsertUser } from "../store";
import {
  captureFeedbackReply,
  processCallbackUpdate,
  processReactionUpdate,
  type FeedbackDeps,
  type FeedbackTransport,
} from "./flows";
import {
  DISLIKE_OPTIONS,
  LIKE_OPTIONS,
  MENU_AWAITING_TEXT,
  MENU_NOT_YOURS_TOAST,
  MENU_RECORDED_TOAST,
  NOT_ADDRESSED_OPTION,
  encodeMenuCallback,
} from "./menu";
import { getFeedback } from "./store";

const MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

const CHAT_ID = "-2002";
const REACTOR_ID = "5001";

/** A 👍/👎 `message_reaction` update from the reactor (invented ids only). */
function reactionUpdate(input: {
  messageId: number;
  emoji?: string;
  userId?: number;
  removed?: boolean;
}): MessageReactionUpdated {
  const emoji = input.emoji ?? "👍";
  return {
    chat: { id: Number(CHAT_ID), type: "supergroup", title: "Fixture Group" },
    message_id: input.messageId,
    user: { id: input.userId ?? Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
    date: Math.floor(Date.now() / 1000),
    old_reaction: input.removed ? [{ type: "emoji", emoji }] : [],
    new_reaction: input.removed ? [] : [{ type: "emoji", emoji }],
  } as MessageReactionUpdated;
}

interface RecordedTransport extends FeedbackTransport {
  menus: Array<{ chatId: string; text: string; rows: number; replyTo: number }>;
  edits: Array<{ messageId: number; text: string; keyboard: unknown }>;
  deletes: number[];
  toasts: Array<string | undefined>;
}

function fakeTransport(): RecordedTransport {
  let nextMenuId = 900;
  const t: RecordedTransport = {
    menus: [],
    edits: [],
    deletes: [],
    toasts: [],
    async sendMenu(input) {
      t.menus.push({
        chatId: input.chatId,
        text: input.text,
        rows: input.keyboard.length,
        replyTo: input.replyToMessageId,
      });
      return { messageId: ++nextMenuId };
    },
    async editMenu(input) {
      t.edits.push({ messageId: input.messageId, text: input.text, keyboard: input.keyboard });
    },
    async deleteMenu(input) {
      t.deletes.push(input.messageId);
    },
    async answerCallback(input) {
      t.toasts.push(input.text);
    },
  };
  return t;
}

describe("tg feedback flows", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("tg_feedback");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });

    await upsertUser(db, {
      userId: REACTOR_ID,
      username: "alice_example",
      firstName: "Alice",
      lastName: null,
    });
    // The conversation: a human message (#31) and two bot replies (#32, #34).
    await appendMessage(db, {
      chatId: CHAT_ID,
      telegramMessageId: 31,
      role: "user",
      userId: REACTOR_ID,
      content: "a question",
      replyToMessageId: null,
      sentAt: new Date(),
      processed: true,
    });
    for (const id of [32, 34]) {
      await appendMessage(db, {
        chatId: CHAT_ID,
        telegramMessageId: id,
        role: "assistant",
        userId: null,
        content: `answer ${id}`,
        replyToMessageId: 31,
        sentAt: new Date(),
        processed: true,
      });
    }
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  function deps(transport: RecordedTransport, published: unknown[]): FeedbackDeps {
    return {
      db,
      transport,
      publish: async (event) => {
        published.push(event);
      },
    };
  }

  it("a 👍 on the bot's reply opens a feedback row and posts the options menu", async () => {
    const transport = fakeTransport();
    const outcome = await processReactionUpdate(
      reactionUpdate({ messageId: 32 }),
      deps(transport, []),
    );
    expect(outcome.status).toBe("menu_sent");
    const feedback = outcome.status === "menu_sent" ? outcome.feedback : null;
    expect(feedback).toMatchObject({ reaction: "up", status: "pending", userId: REACTOR_ID });
    // Five predefined options plus "Other", attached under the reacted reply.
    expect(transport.menus).toEqual([
      {
        chatId: CHAT_ID,
        text: expect.stringContaining("👍"),
        rows: LIKE_OPTIONS.length + 1,
        replyTo: 32,
      },
    ]);
    const stored = await getFeedback(db, feedback!.id);
    expect(stored!.menuMessageId).not.toBeNull();
  });

  it("ignores non-thumbs, removals, human targets, and unmirrored messages", async () => {
    const transport = fakeTransport();
    const d = deps(transport, []);
    expect(
      (await processReactionUpdate(reactionUpdate({ messageId: 32, emoji: "🔥" }), d)).status,
    ).toBe("ignored");
    expect(
      (await processReactionUpdate(reactionUpdate({ messageId: 32, removed: true }), d)).status,
    ).toBe("ignored");
    const human = await processReactionUpdate(reactionUpdate({ messageId: 31 }), d);
    expect(human).toEqual({ status: "ignored", reason: "not_bot_message" });
    const unknown = await processReactionUpdate(reactionUpdate({ messageId: 999 }), d);
    expect(unknown).toEqual({ status: "ignored", reason: "unknown_message" });
    expect(transport.menus).toEqual([]);
  });

  it("a predefined press records the answer, retires the menu, and publishes the event", async () => {
    const transport = fakeTransport();
    const published: unknown[] = [];
    const d = deps(transport, published);
    const opened = await processReactionUpdate(reactionUpdate({ messageId: 32 }), d);
    const feedback = opened.status === "menu_sent" ? opened.feedback : null;
    const menuMessageId = opened.status === "menu_sent" ? opened.menuMessageId : 0;

    // A press from someone else only gets the not-yours toast.
    const stranger = await processCallbackUpdate(
      {
        id: "cb-1",
        from: { id: 6002, is_bot: false, first_name: "Bob" },
        data: encodeMenuCallback(feedback!.id, 0),
        message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        } as never,
      },
      d,
    );
    expect(stranger.status).toBe("not_yours");
    expect(transport.toasts).toContain(MENU_NOT_YOURS_TOAST);

    const pressed = await processCallbackUpdate(
      {
        id: "cb-2",
        from: { id: Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedback!.id, 0),
        message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        } as never,
      },
      d,
    );
    expect(pressed.status).toBe("recorded");
    expect(transport.deletes).toContain(menuMessageId);
    expect(transport.toasts).toContain(MENU_RECORDED_TOAST);

    const stored = await getFeedback(db, feedback!.id);
    expect(stored).toMatchObject({
      status: "completed",
      feedback: LIKE_OPTIONS[0],
      topic: "quality",
    });
    const event = feedbackRecordedEventSchema.parse(published[0]);
    expect(event.feedback).toMatchObject({
      id: feedback!.id,
      chatRef: `tg:chat:${CHAT_ID}`,
      sourceMessageId: "32",
      userRef: `tg:user:${REACTOR_ID}`,
      reaction: "up",
      text: LIKE_OPTIONS[0],
      topic: "quality",
    });
    expect(event.correlationId).toBe(`${CHAT_ID}:32`);
  });

  it("'wasn't talking to you' completes as an addressing report", async () => {
    const transport = fakeTransport();
    const published: unknown[] = [];
    const d = deps(transport, published);
    const opened = await processReactionUpdate(
      reactionUpdate({ messageId: 34, emoji: "👎" }),
      d,
    );
    const feedback = opened.status === "menu_sent" ? opened.feedback : null;
    const menuMessageId = opened.status === "menu_sent" ? opened.menuMessageId : 0;

    await processCallbackUpdate(
      {
        id: "cb-3",
        from: { id: Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedback!.id, DISLIKE_OPTIONS.indexOf(NOT_ADDRESSED_OPTION)),
        message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        } as never,
      },
      d,
    );
    const event = feedbackRecordedEventSchema.parse(published[0]);
    expect(event.feedback).toMatchObject({
      reaction: "down",
      text: NOT_ADDRESSED_OPTION,
      topic: "addressing",
    });
  });

  it("'Other' awaits a reply; the reactor's reply to the menu is the answer, not a turn", async () => {
    const transport = fakeTransport();
    const published: unknown[] = [];
    const d = deps(transport, published);
    // Re-react on #32 (the reopen path) and choose "Other".
    const opened = await processReactionUpdate(reactionUpdate({ messageId: 32 }), d);
    const feedback = opened.status === "menu_sent" ? opened.feedback : null;
    const menuMessageId = opened.status === "menu_sent" ? opened.menuMessageId : 0;
    await processCallbackUpdate(
      {
        id: "cb-4",
        from: { id: Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedback!.id, "other"),
        message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        } as never,
      },
      d,
    );
    expect(transport.edits).toEqual([
      { messageId: menuMessageId, text: MENU_AWAITING_TEXT, keyboard: null },
    ]);

    // The reply to the menu, arriving as an ordinary inbound message with the
    // capture hook wired the way the bot manager wires it.
    const enqueued: InboundMessageEvent[] = [];
    const result = await processIncomingMessage(
      {
        message_id: 51,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(CHAT_ID), type: "supergroup", title: "Fixture Group" },
        from: { id: Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
        text: "too formal for this chat",
        reply_to_message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        },
      } as never,
      {
        db,
        assistantId: "assistant-1",
        identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
        botId: 999,
        botToken: "12345:fixture-token",
        enqueue: async (event) => {
          enqueued.push(event);
        },
        captureFeedback: async (input) => (await captureFeedbackReply(input, d)) != null,
      },
    );
    expect(result).toEqual({ status: "mirrored_only", reason: "feedback_captured" });
    expect(enqueued).toEqual([]);
    expect(transport.deletes).toContain(menuMessageId);

    const stored = await getFeedback(db, feedback!.id);
    expect(stored).toMatchObject({ status: "completed", feedback: "too formal for this chat" });
    const event = feedbackRecordedEventSchema.parse(published[0]);
    expect(event.feedback.text).toBe("too formal for this chat");

    // The answer stays mirrored, and its live-processing hold is released —
    // no turn will ever settle a captured message.
    const mirrored = await getMessageByTelegramId(db, CHAT_ID, 51);
    expect(mirrored).toMatchObject({ content: "too formal for this chat", processed: true });
  });

  it("a reply to the menu from someone else is a normal turn", async () => {
    const transport = fakeTransport();
    const published: unknown[] = [];
    const d = deps(transport, published);
    const opened = await processReactionUpdate(
      reactionUpdate({ messageId: 34, emoji: "👎" }),
      d,
    );
    const feedback = opened.status === "menu_sent" ? opened.feedback : null;
    const menuMessageId = opened.status === "menu_sent" ? opened.menuMessageId : 0;
    await processCallbackUpdate(
      {
        id: "cb-5",
        from: { id: Number(REACTOR_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedback!.id, "other"),
        message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        } as never,
      },
      d,
    );

    const enqueued: InboundMessageEvent[] = [];
    const result = await processIncomingMessage(
      {
        message_id: 61,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(CHAT_ID), type: "supergroup", title: "Fixture Group" },
        from: { id: 6002, is_bot: false, first_name: "Bob", username: "bob_example" },
        text: "what menu is this?",
        reply_to_message: {
          message_id: menuMessageId,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
        },
      } as never,
      {
        db,
        assistantId: "assistant-1",
        identity: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
        botId: 999,
        botToken: "12345:fixture-token",
        enqueue: async (event) => {
          enqueued.push(event);
        },
        captureFeedback: async (input) => (await captureFeedbackReply(input, d)) != null,
      },
    );
    expect(result.status).toBe("enqueued");
    expect(enqueued).toHaveLength(1);
    const stored = await getFeedback(db, feedback!.id);
    expect(stored!.status).toBe("awaiting_text");
  });

describe("internal feedback API (the core's learning seam)", () => {
  function api() {
    return createApi({
      db,
      manager: {
        statuses: () => [],
        senderFor: () => {
          throw new Error("no sends in this test");
        },
        reconcileConnection: async () => undefined,
        removeConnection: async () => undefined,
      },
      internalToken: "secret-token",
    });
  }
  const HEADERS = { "x-internal-token": "secret-token", "content-type": "application/json" };

  it("lists rows, narrows to the fold backlogs, and takes the core's write-backs", async () => {
    const app = api();
    const listed = internalFeedbacksResponseSchema.parse(
      await (await app.request("/internal/feedbacks", { headers: HEADERS })).json(),
    );
    // Rows accumulated by the flow tests above; completed quality ones are
    // the prefs backlog until a version stamp lands.
    const completedQuality = listed.feedbacks.filter(
      (f) => f.status === "completed" && f.topic === "quality",
    );
    expect(completedQuality.length).toBeGreaterThan(0);
    const backlog = internalFeedbacksResponseSchema.parse(
      await (await app.request("/internal/feedbacks?needs=prefs", { headers: HEADERS })).json(),
    );
    expect(backlog.feedbacks.map((f) => f.id).sort()).toEqual(
      completedQuality
        .filter((f) => f.prefsVersion == null)
        .map((f) => f.id)
        .sort(),
    );

    const target = backlog.feedbacks[0];
    const patched = internalFeedbackResponseSchema.parse(
      await (
        await app.request(`/internal/feedbacks/${target.id}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({
            model: "gemma3:12b",
            reflection: "Went long.",
            reflectionModel: "gemma3:12b",
            prefsVersion: 1,
          }),
        })
      ).json(),
    );
    expect(patched.feedback).toMatchObject({
      id: target.id,
      model: "gemma3:12b",
      reflection: "Went long.",
      prefsVersion: 1,
    });
    // The stamped row left the prefs backlog.
    const after = internalFeedbacksResponseSchema.parse(
      await (await app.request("/internal/feedbacks?needs=prefs", { headers: HEADERS })).json(),
    );
    expect(after.feedbacks.map((f) => f.id)).not.toContain(target.id);

    // Unknown rows 404; an empty patch is refused.
    expect(
      (
        await app.request("/internal/feedbacks/ghost", {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ model: "m" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/internal/feedbacks/${target.id}`, {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);
  });

  it("serves one mirrored message (the exchange read)", async () => {
    const app = api();
    const found = operatorMessageResponseSchema.parse(
      await (await app.request(`/internal/chats/${CHAT_ID}/messages/31`, { headers: HEADERS })).json(),
    );
    expect(found.message).toMatchObject({
      sourceMessageId: "31",
      role: "user",
      content: "a question",
    });
    const missing = operatorMessageResponseSchema.parse(
      await (
        await app.request(`/internal/chats/${CHAT_ID}/messages/424242`, { headers: HEADERS })
      ).json(),
    );
    expect(missing.message).toBeNull();
  });
});
});
