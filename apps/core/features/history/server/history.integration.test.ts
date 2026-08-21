import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { listTraces, startTrace } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import { TRANSCRIPT_PREAMBLE } from "./format";
import { getChatMessagesByTelegramIds, getChatMessagesInRange } from "./repository";
import { searchChatMessagesHybrid } from "./search-repository";
import {
  applyMessageEdit,
  composeCurrentTurn,
  getChatHistory,
  getConversationWindow,
  getHistoryOverview,
  recordAssistantMessage,
  recordBotReaction,
  recordIncomingMessage,
} from "./service";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "telegram" } as const;

const TODAY = new Date("2026-07-12T12:00:00.000Z");
const EARLIER_TODAY = new Date("2026-07-12T09:00:00.000Z");
const YESTERDAY = new Date("2026-07-11T23:00:00.000Z");
/** More than 24 hours before TODAY — outside the rolling history window. */
const BEYOND_WINDOW = new Date("2026-07-11T09:00:00.000Z");

describe("recordIncomingMessage", () => {
  it("stores a message and is idempotent on (chatId, telegramMessageId)", async () => {
    const first = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hello", sentAt: TODAY },
      ctx.db,
    );
    expect(first).toMatchObject({ chatId: "5", telegramMessageId: 1, role: "user", content: "hello" });

    // Re-delivery of the same message does not duplicate the row.
    const dup = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hello", sentAt: TODAY },
      ctx.db,
    );
    expect(dup).toBeNull();
    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(1);
  });

  it("ignores an empty message rather than storing a blank row", async () => {
    const out = await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "   ", sentAt: TODAY },
      ctx.db,
    );
    expect(out).toBeNull();
    expect(await getChatHistory("5", {}, ctx.db)).toHaveLength(0);
  });
});

describe("getChatHistory", () => {
  it("returns the chat's messages newest first (detail view order)", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "first", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 2, content: "second", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "third", sentAt: TODAY },
      ctx.db,
    );

    const messages = await getChatHistory("5", {}, ctx.db);
    expect(messages.map((m) => m.content)).toEqual(["third", "second", "first"]);
  });

  it("annotates each message with a media suffix from the injected loader", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 10, userId: "100", content: "", sentAt: TODAY, hasMedia: true },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 11, userId: "100", content: "hi", sentAt: TODAY },
      ctx.db,
    );

    const messages = await getChatHistory(
      "5",
      { loadMediaSuffixes: async (ids) => new Map(ids.filter((id) => id === 10).map((id) => [id, " [photo: a cat]"])) },
      ctx.db,
    );
    const byId = new Map(messages.map((m) => [m.telegramMessageId, m]));
    expect(byId.get(10)?.mediaSuffix).toBe(" [photo: a cat]"); // media message annotated
    expect(byId.get(11)?.mediaSuffix).toBeNull(); // text message unannotated
  });
});

describe("bot reactions", () => {
  /** Seed one human message the bot can react to. */
  async function seedMessage(telegramMessageId = 598) {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId, userId: "100", content: "hello", sentAt: TODAY },
      ctx.db,
    );
    return telegramMessageId;
  }

  /** The rendered transcript of the reply window (or "" when empty). */
  async function transcript(): Promise<string> {
    const window = await getConversationWindow({ chatId: "5", now: TODAY }, ctx.db);
    return String(window.messages[0]?.content ?? "");
  }

  it("renders the reaction on the target line, replaces on re-react, clears on removal", async () => {
    const id = await seedMessage();

    // The scenario this exists for: the bot liked a message, the user asked
    // "did you just like my message?", and the bot — with no record — denied
    // it. The window now carries the reaction on the exact line it sits under.
    await recordBotReaction({ chatId: "5", telegramMessageId: id, emoji: "👍" }, ctx.db);
    expect(await transcript()).toContain(`[#${id}] User 100: hello [you reacted: 👍]`);

    // One reaction per message (Telegram semantics): a re-react replaces.
    await recordBotReaction({ chatId: "5", telegramMessageId: id, emoji: "🔥" }, ctx.db);
    const replaced = await transcript();
    expect(replaced).toContain("[you reacted: 🔥]");
    expect(replaced).not.toContain("👍");

    // Removing the reaction removes the memory of it — current state only,
    // exactly what Telegram shows under the message.
    await recordBotReaction({ chatId: "5", telegramMessageId: id, emoji: null }, ctx.db);
    expect(await transcript()).not.toContain("[you reacted");
  });

  it("stacks the reaction after a media suffix on the same line", async () => {
    const id = await seedMessage(599);
    await recordBotReaction({ chatId: "5", telegramMessageId: id, emoji: "👍" }, ctx.db);

    const window = await getConversationWindow(
      {
        chatId: "5",
        now: TODAY,
        loadMediaSuffixes: async () => new Map([[id, " [photo: a cat]"]]),
      },
      ctx.db,
    );
    expect(String(window.messages[0]?.content)).toContain(
      `[#${id}] User 100: hello [photo: a cat] [you reacted: 👍]`,
    );
  });

  it("annotates the dashboard read with the reaction too", async () => {
    const id = await seedMessage(600);
    await recordBotReaction({ chatId: "5", telegramMessageId: id, emoji: "👍" }, ctx.db);

    const messages = await getChatHistory("5", {}, ctx.db);
    expect(messages.find((m) => m.telegramMessageId === id)?.mediaSuffix).toBe(
      " [you reacted: 👍]",
    );
  });

  it("refuses to remember a reaction on a message that is not mirrored", async () => {
    // The reaction is state ON the mirror row — with no row there is nothing to
    // record it on, and silently succeeding would leave the bot denying it.
    await expect(
      recordBotReaction({ chatId: "5", telegramMessageId: 12345, emoji: "👍" }, ctx.db),
    ).rejects.toThrow(/not mirrored/);
  });
});

describe("getChatHistory trace links", () => {
  it("links a user message and its reply to the trace that handled the turn", async () => {
    // A reply trace correlates to the incoming message: `${chatId}:${messageId}`.
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "telegram", correlationId: "5:1" },
      inputSummary: "hi",
    });
    await trace.succeed({ outputSummary: "hello" });

    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "hi", sentAt: TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 2, content: "hello", replyToMessageId: 1, sentAt: TODAY },
      ctx.db,
    );
    // A later, un-addressed message with no trace.
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "no trace", sentAt: TODAY },
      ctx.db,
    );

    const messages = await getChatHistory("5", {}, ctx.db);
    const byMsg = (id: number) => messages.find((m) => m.telegramMessageId === id)!;
    // Both the user turn and its reply resolve to the same handling trace.
    expect(byMsg(1).traceId).toBe(trace.id);
    expect(byMsg(2).traceId).toBe(trace.id);
    // The un-addressed message has no trace.
    expect(byMsg(3).traceId).toBeNull();
  });
});

describe("getConversationWindow", () => {
  it("returns the last 24 hours as one transcript message, excluding the current turn", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "too old", sentAt: BEYOND_WINDOW },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "yesterday evening", sentAt: YESTERDAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 3, content: "a reply", replyToMessageId: 2, sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 4, userId: "100", content: "current", sentAt: TODAY },
      ctx.db,
    );

    const window = await getConversationWindow(
      { chatId: "5", botLabel: "You (@MyBot)", excludeTelegramMessageId: 4, now: TODAY },
      ctx.db,
    );
    expect(window.count).toBe(2);
    expect(window.messages).toEqual([
      {
        role: "user",
        content:
          `${TRANSCRIPT_PREAMBLE}\n\n` +
          "[#2] User 100: yesterday evening\n" +
          "[#3] You (@MyBot) [reply to #2]: a reply",
      },
    ]);
  });

  it("returns no messages when the window is empty", async () => {
    const window = await getConversationWindow({ chatId: "5", now: TODAY }, ctx.db);
    expect(window).toEqual({ messages: [], count: 0 });
  });

  it("keeps only the newest N messages when capped with maxMessages", async () => {
    for (const [id, content] of [
      [1, "oldest"],
      [2, "middle"],
      [3, "newest"],
    ] as const) {
      await recordIncomingMessage(
        {
          chatId: "5",
          telegramMessageId: id,
          userId: "100",
          content,
          sentAt: new Date(EARLIER_TODAY.getTime() + id * 60_000),
        },
        ctx.db,
      );
    }

    const window = await getConversationWindow({ chatId: "5", now: TODAY, maxMessages: 2 }, ctx.db);
    // The cap drops the oldest turns first — recency wins in a shrunken window.
    expect(window.count).toBe(2);
    expect(window.messages[0].content).not.toContain("[#1] User 100: oldest");
    expect(window.messages[0].content).toContain("[#2] User 100: middle");
    expect(window.messages[0].content).toContain("[#3] User 100: newest");

    // A cap of zero yields an empty window without touching the transcript shape.
    const empty = await getConversationWindow({ chatId: "5", now: TODAY, maxMessages: 0 }, ctx.db);
    expect(empty).toEqual({ messages: [], count: 0 });
  });

  it("labels user turns with the known-user label", async () => {
    await upsertKnownUser(ctx.db, {
      userId: "100",
      username: "alice",
      firstName: "Alice",
      lastName: null,
    });
    await recordIncomingMessage(
      { chatId: "-100", telegramMessageId: 1, userId: "100", content: "hi all", sentAt: EARLIER_TODAY },
      ctx.db,
    );

    const window = await getConversationWindow({ chatId: "-100", now: TODAY }, ctx.db);
    expect(window.messages).toHaveLength(1);
    expect(window.messages[0].content).toContain("[#1] Alice (@alice): hi all");
  });
});

describe("composeCurrentTurn", () => {
  it("renders a plain message as an anchored transcript line", async () => {
    const turn = await composeCurrentTurn(
      {
        chatId: "-100",
        telegramMessageId: 7,
        senderLabel: "Bob (@bob)",
        content: "@bot what do you think?",
      },
      ctx.db,
    );
    expect(turn.content).toBe("[#7] Bob (@bob): @bot what do you think?");
    expect(turn.senderLabel).toBe("Bob (@bob)");
    expect(turn.data.replyTo).toBeNull();
  });

  it("anchors the reply target by id when it is stored in the mirror", async () => {
    await recordIncomingMessage(
      { chatId: "-100", telegramMessageId: 5, userId: "100", content: "the sky is green", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    const turn = await composeCurrentTurn(
      {
        chatId: "-100",
        telegramMessageId: 8,
        senderLabel: "Bob (@bob)",
        content: "@bot tell him he is wrong",
        replyTo: { telegramMessageId: 5, senderLabel: "Alice (@alice)", text: "the sky is green" },
      },
      ctx.db,
    );
    expect(turn.content).toBe("[#8] Bob (@bob) [reply to #5]: @bot tell him he is wrong");
    expect(turn.data.replyTo).toEqual({ telegramMessageId: 5, resolved: "anchor" });
  });

  it("inlines the quoted sender and full text when the target is not stored", async () => {
    const turn = await composeCurrentTurn(
      {
        chatId: "-100",
        telegramMessageId: 9,
        senderLabel: "Bob (@bob)",
        content: "@bot is that true?",
        replyTo: { telegramMessageId: 999, senderLabel: "Alice (@alice)", text: "the sky is green" },
      },
      ctx.db,
    );
    expect(turn.content).toBe(
      '[#9] Bob (@bob) [reply to Alice (@alice): "the sky is green"]: @bot is that true?',
    );
    expect(turn.data.replyTo).toEqual({ telegramMessageId: 999, resolved: "inline" });
  });

  it("carries a partial quote on a stored reply target", async () => {
    await recordIncomingMessage(
      { chatId: "-100", telegramMessageId: 5, userId: "100", content: "long rant. the sky is green. more rant", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    const turn = await composeCurrentTurn(
      {
        chatId: "-100",
        telegramMessageId: 10,
        senderLabel: "Bob (@bob)",
        content: "@bot debunk this",
        replyTo: {
          telegramMessageId: 5,
          senderLabel: "Alice (@alice)",
          text: "long rant. the sky is green. more rant",
          quote: "the sky is green",
        },
      },
      ctx.db,
    );
    expect(turn.content).toBe(
      '[#10] Bob (@bob) [reply to #5, quoting: "the sky is green"]: @bot debunk this',
    );
  });
});

describe("getChatMessagesByTelegramIds", () => {
  it("returns matching non-deleted messages oldest first, scoped to the chat", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "first", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "second", sentAt: TODAY },
      ctx.db,
    );
    // Same Telegram id in another chat must never leak in.
    await recordIncomingMessage(
      { chatId: "9", telegramMessageId: 1, userId: "200", content: "other chat", sentAt: TODAY },
      ctx.db,
    );

    const hits = await getChatMessagesByTelegramIds(ctx.db, "5", [2, 1, 999]);
    expect(hits.map((h) => h.content)).toEqual(["first", "second"]);
    expect(await getChatMessagesByTelegramIds(ctx.db, "5", [])).toEqual([]);
  });
});

describe("applyMessageEdit", () => {
  it("rewrites a stored message and records a success trace", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "typo", sentAt: TODAY },
      ctx.db,
    );
    const updated = await applyMessageEdit(
      { chatId: "5", telegramMessageId: 1, content: "fixed", editedAt: TODAY },
      trigger,
      ctx.db,
    );
    expect(updated).toMatchObject({ content: "fixed" });
    expect(updated?.editedAt).not.toBeNull();

    const stored = await getChatHistory("5", {}, ctx.db);
    expect(stored[0].content).toBe("fixed");

    const { traces } = await listTraces({ feature: "history" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "edit", status: "success" });
  });

  it("skips (not fails) when the edited message was never stored", async () => {
    const out = await applyMessageEdit(
      { chatId: "5", telegramMessageId: 999, content: "ghost", editedAt: TODAY },
      trigger,
      ctx.db,
    );
    expect(out).toBeNull();
    const { traces } = await listTraces({ feature: "history" });
    expect(traces[0]).toMatchObject({ action: "edit", status: "skipped" });
  });
});

describe("getHistoryOverview", () => {
  it("summarizes each chat with a count and last activity, most-recent first", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "one", sentAt: YESTERDAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "two", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "9", telegramMessageId: 1, userId: "200", content: "solo", sentAt: TODAY },
      ctx.db,
    );

    const overview = await getHistoryOverview(ctx.db);
    expect(overview).toHaveLength(2);
    // Chat 9's last activity (TODAY) is more recent than chat 5's (EARLIER_TODAY).
    expect(overview[0]).toMatchObject({ chatId: "9", messageCount: 1 });
    expect(overview[1]).toMatchObject({ chatId: "5", messageCount: 2 });
  });
});

describe("searchChatMessagesHybrid", () => {
  /** Hits in message order — the fused result is ranked, not chronological. */
  const inOrder = (hits: { telegramMessageId: number; content: string }[]) =>
    [...hits].sort((a, b) => a.telegramMessageId - b.telegramMessageId).map((h) => h.content);

  /** Lexical-only search: the shape when no embedding model is configured. */
  const search = (chatId: string, query: string, limit: number) =>
    searchChatMessagesHybrid(ctx.db, { chatId, queryText: query, queryVector: null, limit });

  it("matches content case-insensitively, excludes other chats, and caps at the limit", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "I love Pizza", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordAssistantMessage(
      { chatId: "5", telegramMessageId: 2, content: "pizza is great", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "unrelated", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    // A different chat must never leak into another chat's search.
    await recordIncomingMessage(
      { chatId: "9", telegramMessageId: 1, userId: "100", content: "pizza elsewhere", sentAt: EARLIER_TODAY },
      ctx.db,
    );

    const hits = await search("5", "pizza", 50);
    expect(inOrder(hits)).toEqual(["I love Pizza", "pizza is great"]);

    const capped = await search("5", "pizza", 1);
    expect(capped).toHaveLength(1);
  });

  it("treats LIKE metacharacters as literals", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "discount 50% today", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "no percent here", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    const hits = await search("5", "50%", 50);
    expect(inOrder(hits)).toEqual(["discount 50% today"]);
  });
});

describe("getChatMessagesInRange", () => {
  it("returns messages within the inclusive range, oldest first", async () => {
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 1, userId: "100", content: "yesterday", sentAt: YESTERDAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 2, userId: "100", content: "early today", sentAt: EARLIER_TODAY },
      ctx.db,
    );
    await recordIncomingMessage(
      { chatId: "5", telegramMessageId: 3, userId: "100", content: "midday today", sentAt: TODAY },
      ctx.db,
    );

    const range = await getChatMessagesInRange(
      ctx.db,
      "5",
      new Date("2026-07-12T00:00:00.000Z"),
      new Date("2026-07-12T23:59:59.000Z"),
    );
    expect(range.map((r) => r.content)).toEqual(["early today", "midday today"]);
  });
});
