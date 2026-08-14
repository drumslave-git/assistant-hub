import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactionTypeEmoji } from "@grammyjs/types";

import { closePool } from "@/db/pool";
import { ADDRESSING_CHECK_EVENT } from "@/features/bot-messaging/addressing-trace";
import {
  listAddressingExclusions,
  listAddressingExclusionTerms,
} from "@/features/bot-messaging/server/exclusions-repository";
import { chatMessages, knownUsers, selfCorrections, usersCommunicationPreferences, usersFeedbacks } from "@/db/schema";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { getTrace, listTraces, startTrace } from "@/server/trace";
import { processCallbackUpdate } from "@/server/telegram/process-callback";
import { processReactionUpdate } from "@/server/telegram/process-reaction";
import type { FeedbackTransport } from "@/server/telegram/transport";
import { simulateUpdate } from "@/test/simulate";
import { startTestDb, type TestDb } from "@/test/db";

import {
  encodeMenuCallback,
  MENU_AWAITING_TEXT,
  MENU_RECORDED_TOAST,
  OTHER_OPTION,
} from "../menu";
import { DISLIKE_OPTIONS, LIKE_OPTIONS, NOT_ADDRESSED_OPTION } from "../options";
import { runSelfImprovement } from "./analyze";
import { removeAddressingExclusion } from "./service";
import { reflectOnFeedback } from "./reflect";
import {
  completeFeedback,
  getFeedback,
  getLatestCorrection,
  getLatestPreference,
  insertCorrection,
  insertPreference,
  setFeedbackReflection,
  upsertFeedback,
} from "./repository";

/**
 * Integration coverage for the self-improvement feature against a real
 * Postgres: the reaction → menu → answer collection flows (through the real
 * transport-agnostic processors with a capturing feedback transport), the
 * free-text capture through the real message pipeline, the self-reflection pass
 * over an answered feedback, the daily incorporation run with a deterministic
 * LLM, and the resulting prompt injection on a reply.
 */

let ctx: TestDb;
let prevDatabaseUrl: string | undefined;

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  // The flows run through the app's own pool (`getDb()`), so bind it here.
  process.env.DATABASE_URL = ctx.connectionUri;
});

afterAll(async () => {
  stopVisionBackfill();
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT_ID = "555";
const USER_ID = "100";
const USER_MSG_ID = 10;
const BOT_MSG_ID = 11;
const MENU_MSG_ID = 500;
/** A proactively-sent message (scheduled-task fire) — no reply pointer. */
const FIRED_MSG_ID = 42;

/** Seed a known user plus one mirrored exchange (user #10 → bot reply #11). */
async function seedExchange(userId = USER_ID): Promise<void> {
  await ctx.db
    .insert(knownUsers)
    .values({ userId, username: `user${userId}`, firstName: `U${userId}` })
    .onConflictDoNothing();
  await ctx.db
    .insert(chatMessages)
    .values([
      {
        chatId: CHAT_ID,
        telegramMessageId: USER_MSG_ID,
        role: "user",
        userId,
        content: "what's the weather?",
        sentAt: new Date("2026-07-14T10:00:00Z"),
      },
      {
        chatId: CHAT_ID,
        telegramMessageId: BOT_MSG_ID,
        role: "assistant",
        content: "Sunny, 25°C.",
        replyToMessageId: USER_MSG_ID,
        sentAt: new Date("2026-07-14T10:00:05Z"),
      },
    ])
    .onConflictDoNothing();
}

/** A capturing FeedbackTransport (the simulator's sibling for menu flows). */
function fakeFeedbackTransport() {
  const sendMenu = vi.fn().mockResolvedValue({ messageId: MENU_MSG_ID });
  const editMenu = vi.fn().mockResolvedValue(undefined);
  const deleteMenu = vi.fn().mockResolvedValue(undefined);
  const answerCallback = vi.fn().mockResolvedValue(undefined);
  const transport: FeedbackTransport = { sendMenu, editMenu, deleteMenu, answerCallback };
  return { transport, sendMenu, editMenu, deleteMenu, answerCallback };
}

/** A thumbs reaction update on the seeded bot reply. */
function reactionUpdate(emoji: ReactionTypeEmoji["emoji"], userId = Number(USER_ID)) {
  return {
    chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
    message_id: BOT_MSG_ID,
    user: { id: userId, is_bot: false, first_name: `U${userId}` },
    date: Math.floor(Date.now() / 1000),
    old_reaction: [],
    new_reaction: [{ type: "emoji" as const, emoji }],
  };
}

async function getFeedbackRow() {
  return ctx.db.query.usersFeedbacks.findFirst();
}

describe("feedback collection (reaction → menu → answer)", () => {
  it("opens a feedback row and sends the menu, resolving the clean model from the reply trace", async () => {
    await seedExchange();
    // The reply trace (keyed by the incoming message) carries the raw model id.
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "telegram", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
    });
    await trace.event({
      type: "llm_response",
      message: "response",
      usage: { model: "docker.io/ai/gemma3:12b" },
    });
    await trace.succeed();

    const { transport, sendMenu } = fakeFeedbackTransport();
    const outcome = await processReactionUpdate(reactionUpdate("👍"), transport);

    expect(outcome.status).toBe("menu_sent");
    const row = await getFeedbackRow();
    expect(row).toMatchObject({
      chatId: CHAT_ID,
      telegramMessageId: BOT_MSG_ID,
      userId: USER_ID,
      reaction: "up",
      status: "pending",
      menuMessageId: MENU_MSG_ID,
      model: "gemma3:12b", // clean name — registry prefix stripped
      feedback: null,
    });
    // Menu posted as a reply to the reacted message: 5 options + Other.
    expect(sendMenu).toHaveBeenCalledOnce();
    const menu = sendMenu.mock.calls[0][0];
    expect(menu.replyToMessageId).toBe(BOT_MSG_ID);
    expect(menu.keyboard).toHaveLength(6);
    // Traced under user-feedback.
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.total).toBe(1);
    expect(traces.traces[0]).toMatchObject({ status: "success", action: "menu" });
  });

  it("ignores reactions that are not a thumb, or not on a bot message", async () => {
    await seedExchange();
    const { transport, sendMenu } = fakeFeedbackTransport();

    // Not a thumb.
    expect((await processReactionUpdate(reactionUpdate("🔥"), transport)).status).toBe("ignored");
    // A thumb on the *user's* message.
    expect(
      (
        await processReactionUpdate(
          { ...reactionUpdate("👍"), message_id: USER_MSG_ID },
          transport,
        )
      ).status,
    ).toBe("ignored");
    // A thumb on a message that was never mirrored.
    expect(
      (await processReactionUpdate({ ...reactionUpdate("👍"), message_id: 999 }, transport))
        .status,
    ).toBe("ignored");

    expect(sendMenu).not.toHaveBeenCalled();
    expect(await getFeedbackRow()).toBeUndefined();
  });

  it("records a predefined option with a toast + menu delete, and rejects presses from other users", async () => {
    await seedExchange();
    const { transport, sendMenu, editMenu, deleteMenu, answerCallback } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👍"), transport);
    const feedbackId = (await getFeedbackRow())!.id;
    const menuMessage = {
      message_id: MENU_MSG_ID,
      date: 0,
      chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
    };

    // Someone else presses → toast only, nothing recorded.
    const foreign = await processCallbackUpdate(
      {
        id: "cb-1",
        from: { id: 200, is_bot: false, first_name: "Mallory" },
        data: encodeMenuCallback(feedbackId, 1),
        message: menuMessage,
      },
      transport,
    );
    expect(foreign.status).toBe("not_yours");
    expect(answerCallback).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("person who reacted") }),
    );
    expect((await getFeedbackRow())!.status).toBe("pending");
    expect(deleteMenu).not.toHaveBeenCalled();

    // The reactor picks option 1 → completed, menu gone, acknowledged by a toast.
    const pressed = await processCallbackUpdate(
      {
        id: "cb-2",
        from: { id: Number(USER_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedbackId, 1),
        message: menuMessage,
      },
      transport,
    );
    expect(pressed.status).toBe("recorded");
    expect(await getFeedbackRow()).toMatchObject({
      status: "completed",
      feedback: LIKE_OPTIONS[1],
    });
    expect(deleteMenu).toHaveBeenCalledWith({ chatId: CHAT_ID, messageId: MENU_MSG_ID });
    expect(answerCallback).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: MENU_RECORDED_TOAST }),
    );
    // No confirmation message is left behind — the menu is never rewritten.
    expect(editMenu).not.toHaveBeenCalled();
    expect(sendMenu).toHaveBeenCalledOnce(); // no second menu
  });

  it("captures the free-text answer via a reply to the menu, short-circuiting the bot reply", async () => {
    await seedExchange();
    const { transport, editMenu } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👎"), transport);
    const feedbackId = (await getFeedbackRow())!.id;

    // "Other" → awaiting a reply.
    const other = await processCallbackUpdate(
      {
        id: "cb-3",
        from: { id: Number(USER_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedbackId, OTHER_OPTION),
        message: {
          message_id: MENU_MSG_ID,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
        },
      },
      transport,
    );
    expect(other.status).toBe("awaiting_text");
    expect(editMenu).toHaveBeenCalledWith(expect.objectContaining({ text: MENU_AWAITING_TEXT }));
    expect((await getFeedbackRow())!.status).toBe("awaiting_text");

    // The reactor replies to the menu message → captured, not answered by the LLM.
    const generateReply = vi.fn();
    const deleteFeedbackMenu = vi.fn().mockResolvedValue(undefined);
    const res = await simulateUpdate(
      {
        text: "too sarcastic, keep it factual",
        chatId: Number(CHAT_ID),
        messageId: 12,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
        replyTo: { messageId: MENU_MSG_ID },
      },
      { generateReply, deleteFeedbackMenu },
    );
    expect(res.outcome).toEqual({ status: "ignored", reason: "feedback_captured" });
    expect(generateReply).not.toHaveBeenCalled();
    // The answer is acknowledged by the menu going away — nothing is sent back.
    expect(res.replies).toEqual([]);
    expect(deleteFeedbackMenu).toHaveBeenCalledWith({ chatId: CHAT_ID, messageId: MENU_MSG_ID });
    expect(await getFeedbackRow()).toMatchObject({
      status: "completed",
      feedback: "too sarcastic, keep it factual",
    });
    // A second identical reply is NOT captured again (the row is completed).
    const res2 = await simulateUpdate(
      {
        text: "still bad",
        chatId: Number(CHAT_ID),
        messageId: 13,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
        replyTo: { messageId: MENU_MSG_ID },
      },
      { generateReply: vi.fn().mockResolvedValue({ content: "ok", model: "m", latencyMs: 1 }) },
    );
    expect(res2.outcome.status).toBe("replied");
  });

  it("a repeat reaction reopens the answered row and asks again", async () => {
    await seedExchange();
    const { transport } = fakeFeedbackTransport();
    await processReactionUpdate(reactionUpdate("👍"), transport);
    const feedbackId = (await getFeedbackRow())!.id;
    await completeFeedback(ctx.db, feedbackId, "great");

    await processReactionUpdate(reactionUpdate("👎"), transport);
    const row = await getFeedbackRow();
    expect(row).toMatchObject({ id: feedbackId, reaction: "down", status: "pending", feedback: null });
  });
});

/**
 * Deterministic LLM for the daily run, answering by the system prompt it is
 * given: a reflection, a preferences profile (JSON), or correction guidelines.
 */
function fakeFoldLlm(outputs?: {
  likes?: string;
  dislikes?: string;
  correction?: string;
  reflection?: string;
}) {
  const calls: ChatMessage[][] = [];
  const complete = async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
    calls.push(messages);
    const system = String(messages[0].content);
    const content = system.includes("reviewing one of your own replies")
      ? (outputs?.reflection ?? "Padded a one-line answer with background nobody asked for.")
      : system.includes("factual profile")
        ? JSON.stringify({
            likes: outputs?.likes ?? "short answers",
            dislikes: outputs?.dislikes ?? "rambling",
          })
        : (outputs?.correction ?? "Be more concise.");
    return {
      content,
      model: "docker.io/ai/gemma3:12b",
      latencyMs: 1,
      requestBody: { messages },
      responseBody: { content },
    };
  };
  return { complete, calls };
}

/** Seed one completed feedback for a user on the shared exchange. */
async function seedCompletedFeedback(userId: string, feedback: string) {
  await seedExchange(userId);
  const row = await upsertFeedback(ctx.db, {
    id: crypto.randomUUID(),
    chatId: CHAT_ID,
    telegramMessageId: BOT_MSG_ID,
    userId,
    reaction: "down",
    model: "gemma3:12b",
  });
  await completeFeedback(ctx.db, row.id, feedback);
  return row.id;
}

describe("self-reflection (reflectOnFeedback)", () => {
  /** The reply trace the reflection reads: how the bot produced the reacted reply. */
  async function seedReplyTrace() {
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "telegram", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
    });
    await trace.event({
      type: "llm_request",
      message: "request",
      data: {
        messages: [
          { role: "system", content: "You are a bot. Always give the full background." },
          { role: "user", content: "what's the weather?" },
        ],
      },
    });
    await trace.event({
      type: "external_call",
      message: "tool: web_search",
      data: { args: { query: "weather" }, result: { text: "Sunny, 25°C" } },
    });
    await trace.event({
      type: "output",
      level: "success",
      message: "send message",
      data: { content: "Sunny, 25°C.", messageId: BOT_MSG_ID },
    });
    await trace.succeed();
  }

  it("reflects from the reply trace and stores the result on the feedback row", async () => {
    const feedbackId = await seedCompletedFeedback(USER_ID, "too long");
    await seedReplyTrace();
    const reflection = "The persona demanded full background, so a one-line question got an essay.";
    const complete = vi.fn().mockResolvedValue({
      content: reflection,
      model: "docker.io/ai/gemma3:12b",
      latencyMs: 1,
    });

    const result = await reflectOnFeedback((await getFeedback(ctx.db, feedbackId))!, {
      complete,
      model: "docker.io/ai/gemma3:12b",
      db: ctx.db,
    });

    expect(result).toBe(reflection);
    expect(await getFeedback(ctx.db, feedbackId)).toMatchObject({
      reflection,
      reflectionModel: "gemma3:12b", // clean name — registry prefix stripped
    });
    // The call saw the whole causal chain: prompt, tool + result, reply, feedback.
    const asked = String(complete.mock.calls[0][0].at(-1).content);
    expect(asked).toContain("Always give the full background");
    expect(asked).toContain("tool: web_search");
    expect(asked).toContain("Sunny, 25°C.");
    expect(asked).toContain("User feedback: too long");
    // Traced under user-feedback, linked back to the feedback row.
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces[0]).toMatchObject({
      status: "success",
      action: "reflect",
      relatedIds: { users_feedbacks: [feedbackId] },
    });
  });

  it("reflects on a proactively-sent message from the trace that delivered it", async () => {
    // A task fire has no incoming message to key on, so it settles on
    // what it delivered — the reacted message itself, not a reply anchor.
    await seedExchange();
    await ctx.db.insert(chatMessages).values({
      chatId: CHAT_ID,
      telegramMessageId: FIRED_MSG_ID,
      role: "assistant",
      content: "Hey. Just checking in.",
      replyToMessageId: null,
      sentAt: new Date("2026-07-14T12:00:00Z"),
    });
    const fire = await startTrace({
      feature: "tasks",
      action: "fire",
      trigger: { kind: "cron", actor: CHAT_ID, correlationId: "task-uuid" },
    });
    await fire.event({
      type: "llm_request",
      message: "request",
      data: { messages: [{ role: "system", content: "Check in briefly. Never sound scripted." }] },
    });
    await fire.event({
      type: "output",
      level: "success",
      message: "send message",
      data: { content: "Hey. Just checking in.", messageId: FIRED_MSG_ID },
    });
    await fire.succeed({ correlationId: `${CHAT_ID}:${FIRED_MSG_ID}` });

    const row = await upsertFeedback(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT_ID,
      telegramMessageId: FIRED_MSG_ID,
      userId: USER_ID,
      reaction: "up",
      model: "gemma3:12b",
    });
    await completeFeedback(ctx.db, row.id, "Right tone");
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Stayed short and unscripted.", model: "m", latencyMs: 1 });

    await reflectOnFeedback((await getFeedback(ctx.db, row.id))!, { complete, db: ctx.db });

    // The fire's own prompt reached the reflection — no reply pointer involved.
    const asked = String(complete.mock.calls[0][0].at(-1).content);
    expect(asked).toContain("Never sound scripted");
    expect(asked).toContain("Hey. Just checking in.");
  });

  it("reads the producing trace, not the feedback traces keyed on the same message", async () => {
    // The menu/answer/reflect traces all key on the reacted message, so an
    // unscoped "latest trace on this message" would return one of those — and a
    // second reflection would read its own previous output back to itself.
    const feedbackId = await seedCompletedFeedback(USER_ID, "too long");
    await seedReplyTrace();
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Went long.", model: "m", latencyMs: 1 });

    // Two runs: the first leaves a `reflect` trace on `CHAT_ID:BOT_MSG_ID`.
    await reflectOnFeedback((await getFeedback(ctx.db, feedbackId))!, { complete, db: ctx.db });
    await reflectOnFeedback((await getFeedback(ctx.db, feedbackId))!, { complete, db: ctx.db });

    // The second still read the bot-messaging reply trace, not the first
    // reflection. The reflection prompt's own wording is the tell: it can only
    // appear here if the lookup handed back a `reflect` trace.
    const asked = String(complete.mock.calls[1][0].at(-1).content);
    expect(asked).toContain("Always give the full background");
    expect(asked).not.toContain("reviewing one of your own replies");
    const header = (await listTraces({ feature: "user-feedback" })).traces[0];
    const events = (await getTrace(header.id))!.events;
    expect(events.some((e) => e.message.includes("no reply trace"))).toBe(false);
  });

  it("reflects on the exchange alone when the reply has no trace, and says so", async () => {
    const feedbackId = await seedCompletedFeedback(USER_ID, "wrong tone");
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Answered a real question flippantly.", model: "m", latencyMs: 1 });

    await reflectOnFeedback((await getFeedback(ctx.db, feedbackId))!, { complete, db: ctx.db });

    // No trace to reason from — the exchange from the history mirror stands in.
    const asked = String(complete.mock.calls[0][0].at(-1).content);
    expect(asked).toContain("what's the weather?");
    expect(asked).toContain("Sunny, 25°C.");
    expect((await getFeedback(ctx.db, feedbackId))!.reflection).toBe(
      "Answered a real question flippantly.",
    );
    // The operator can see the reflection was the thinner kind.
    const header = (await listTraces({ feature: "user-feedback" })).traces[0];
    const events = (await getTrace(header.id))!.events;
    expect(events.some((e) => e.level === "warn" && e.message.includes("no reply trace"))).toBe(
      true,
    );
  });

  it("leaves the reflection null when the call fails, for the next incorporation run", async () => {
    const feedbackId = await seedCompletedFeedback(USER_ID, "too long");
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));

    expect(
      await reflectOnFeedback((await getFeedback(ctx.db, feedbackId))!, { complete, db: ctx.db }),
    ).toBeNull();
    expect(await getFeedback(ctx.db, feedbackId)).toMatchObject({
      reflection: null,
      reflectionModel: null,
    });
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces[0]).toMatchObject({ status: "skipped", action: "reflect" });
  });

  it("does not reflect on a feedback the user has not answered yet", async () => {
    await seedExchange();
    const pending = await upsertFeedback(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT_ID,
      telegramMessageId: BOT_MSG_ID,
      userId: USER_ID,
      reaction: "down",
      model: "gemma3:12b",
    });
    const complete = vi.fn();

    expect(await reflectOnFeedback(pending, { complete, db: ctx.db })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    // Nothing happened, so nothing is recorded — Debug stays free of noise.
    expect((await listTraces({ feature: "user-feedback" })).total).toBe(0);
  });
});

describe("daily incorporation (runSelfImprovement)", () => {
  it("folds the backlog into new preference versions per user + one correction version, stamping every feedback", async () => {
    await seedCompletedFeedback("100", "too long");
    await seedCompletedFeedback("200", "wrong tone");
    const llm = fakeFoldLlm();

    const result = await runSelfImprovement({
      complete: llm.complete,
      personalityPrompt: "You are a pirate.",
      model: "docker.io/ai/gemma3:12b",
      db: ctx.db,
    });

    expect(result).toMatchObject({
      prefsUpdated: 2,
      correctionsUpdated: true,
      incorporated: 2,
      failed: 0,
    });
    // 2 reflections (neither feedback had one) + 2 preference folds + 2 correction
    // folds — one LLM call per feedback per pass.
    expect(llm.calls).toHaveLength(6);
    // The persona is stated once per call, never repeated per exchange.
    for (const call of llm.calls) {
      const personaMentions = call.filter((m) => String(m.content).includes("You are a pirate."));
      expect(personaMentions).toHaveLength(1);
    }
    // Both folds read the exchange from the history mirror, and the reflection the
    // backfill wrote moments earlier.
    const prefsCall = llm.calls.find((c) => String(c[0].content).includes("factual profile"))!;
    expect(String(prefsCall.at(-1)!.content)).toContain("what's the weather?");
    expect(String(prefsCall.at(-1)!.content)).toContain("Sunny, 25°C.");
    expect(String(prefsCall.at(-1)!.content)).toContain(
      "Padded a one-line answer with background nobody asked for.",
    );
    // The reflections are stored, not just passed through.
    for (const row of await ctx.db.select().from(usersFeedbacks)) {
      expect(row.reflection).toBe("Padded a one-line answer with background nobody asked for.");
      expect(row.reflectionModel).toBe("gemma3:12b");
    }

    for (const userId of ["100", "200"]) {
      expect(await getLatestPreference(ctx.db, userId)).toMatchObject({
        version: 1,
        likes: "short answers",
        dislikes: "rambling",
        model: "gemma3:12b",
      });
    }
    expect(await getLatestCorrection(ctx.db)).toMatchObject({
      version: 1,
      correction: "Be more concise.",
      model: "gemma3:12b",
    });
    const rows = await ctx.db.select().from(usersFeedbacks);
    for (const row of rows) {
      expect(row.prefsVersion).toBe(1);
      expect(row.correctionsVersion).toBe(1);
    }
    // Traced under self-improvement with the full fold bodies.
    const traces = await listTraces({ feature: "self-improvement" });
    expect(traces.total).toBe(1);
    expect(traces.traces[0]).toMatchObject({ status: "success", action: "incorporate" });

    // A second run with nothing new is a silent no-op (no extra trace).
    const again = await runSelfImprovement({ complete: llm.complete, db: ctx.db });
    expect(again.summary).toBe("nothing to incorporate");
    expect((await listTraces({ feature: "self-improvement" })).total).toBe(1);
  });

  it("skips the reflection backfill for a feedback that already has one, and folds from it", async () => {
    const feedbackId = await seedCompletedFeedback("100", "too long");
    // The usual case: the answer was reflected on the moment it arrived.
    await setFeedbackReflection(ctx.db, feedbackId, "Buried the answer in caveats.", "gemma3:12b");
    const llm = fakeFoldLlm();

    await runSelfImprovement({ complete: llm.complete, db: ctx.db });

    // 1 preference fold + 1 correction fold — nothing to re-reflect.
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) {
      expect(String(call[0].content)).not.toContain("reviewing one of your own replies");
      // Both folds reason from the stored reflection, not just the user's words.
      expect(String(call.at(-1)!.content)).toContain("Buried the answer in caveats.");
    }
  });

  it("seeds the next version from the previous one", async () => {
    await seedCompletedFeedback("100", "too long");
    await runSelfImprovement({ complete: fakeFoldLlm().complete, db: ctx.db });

    // A fresh feedback arrives later (a new bot message id to satisfy uniqueness).
    await ctx.db.insert(chatMessages).values({
      chatId: CHAT_ID,
      telegramMessageId: 21,
      role: "assistant",
      content: "Another reply.",
      replyToMessageId: USER_MSG_ID,
      sentAt: new Date("2026-07-14T11:00:00Z"),
    });
    const row = await upsertFeedback(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT_ID,
      telegramMessageId: 21,
      userId: "100",
      reaction: "up",
      model: "gemma3:12b",
    });
    await completeFeedback(ctx.db, row.id, "loved the brevity");

    const llm = fakeFoldLlm({ likes: "brevity", dislikes: "rambling", correction: "Keep it short." });
    await runSelfImprovement({ complete: llm.complete, db: ctx.db });

    // The preference fold started from version 1's profile.
    const prefsCall = llm.calls.find((c) => String(c[0].content).includes("factual profile"))!;
    expect(String(prefsCall.at(-1)!.content)).toContain("short answers");
    expect(await getLatestPreference(ctx.db, "100")).toMatchObject({ version: 2, likes: "brevity" });
    expect(await getLatestCorrection(ctx.db)).toMatchObject({ version: 2, correction: "Keep it short." });
  });

  it("leaves a feedback unstamped for the next run when its fold call fails", async () => {
    await seedCompletedFeedback("100", "too long");
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));

    const result = await runSelfImprovement({ complete, db: ctx.db });
    expect(result.incorporated).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    const row = (await ctx.db.select().from(usersFeedbacks))[0];
    expect(row.prefsVersion).toBeNull();
    expect(row.correctionsVersion).toBeNull();
    expect(await ctx.db.select().from(usersCommunicationPreferences)).toHaveLength(0);
    expect(await ctx.db.select().from(selfCorrections)).toHaveLength(0);
    // The run trace still settles (success with failure counts in the summary).
    const traces = await listTraces({ feature: "self-improvement" });
    expect(traces.total).toBe(1);
  });
});

describe("prompt injection on the next reply", () => {
  it("injects the sender's latest preferences and the latest correction", async () => {
    await seedExchange();
    await insertPreference(ctx.db, {
      id: crypto.randomUUID(),
      userId: USER_ID,
      model: "gemma3:12b",
      likes: "short answers",
      dislikes: "emoji walls",
      version: 1,
    });
    await insertCorrection(ctx.db, {
      id: crypto.randomUUID(),
      model: "gemma3:12b",
      correction: "Answer in fewer words.",
      version: 1,
    });

    const seen: ChatMessage[][] = [];
    const res = await simulateUpdate(
      {
        text: "hi bot",
        chatId: Number(CHAT_ID),
        messageId: 30,
        from: { id: Number(USER_ID), username: "alice", firstName: "Alice" },
      },
      {
        generateReply: async (messages) => {
          seen.push(messages);
          return { content: "hey", model: "m", latencyMs: 1 };
        },
      },
    );

    expect(res.outcome.status).toBe("replied");
    const messages = seen[0];
    // The system prompt carries the correction block.
    expect(String(messages[0].content)).toContain("Self-correction guidelines");
    expect(String(messages[0].content)).toContain("Answer in fewer words.");
    // A system message carries the sender's preferences.
    const prefsMessage = messages.find(
      (m) => m.role === "system" && String(m.content).includes("Communication preferences"),
    );
    expect(prefsMessage).toBeDefined();
    expect(String(prefsMessage!.content)).toContain("short answers");
    expect(String(prefsMessage!.content)).toContain("emoji walls");
  });
});

describe("addressing report (👎 → \"Wasn't talking to you\")", () => {
  const NOT_ADDRESSED_INDEX = DISLIKE_OPTIONS.indexOf(NOT_ADDRESSED_OPTION);

  /**
   * The reply trace the report reads back: the bot answered because the analyzer
   * took `matchedText` for its display name.
   */
  async function seedAddressingTrace(options: {
    source: string;
    matchedText?: string | null;
    botDisplayName?: string;
  }) {
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "telegram", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
    });
    await trace.event({
      type: "step",
      level: "success",
      message: ADDRESSING_CHECK_EVENT,
      data: {
        addressed: true,
        source: options.source,
        reason: "display name appears as other_alphabet",
        matchedText: options.matchedText ?? null,
        botDisplayName: options.botDisplayName ?? "Aria",
      },
    });
    await trace.succeed();
  }

  /** React 👎 and press the "Wasn't talking to you" option. Returns the outcome. */
  async function reportNotAddressed(transport: FeedbackTransport) {
    await processReactionUpdate(reactionUpdate("👎"), transport);
    const feedbackId = (await getFeedbackRow())!.id;
    return processCallbackUpdate(
      {
        id: `cb-${feedbackId}`,
        from: { id: Number(USER_ID), is_bot: false, first_name: "Alice" },
        data: encodeMenuCallback(feedbackId, NOT_ADDRESSED_INDEX),
        message: {
          message_id: MENU_MSG_ID,
          date: 0,
          chat: { id: Number(CHAT_ID), type: "private" as const, first_name: "A" },
        },
      },
      transport,
    );
  }

  it("files the word the analyzer matched, so it stops summoning the bot", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    const { transport } = fakeFeedbackTransport();

    expect((await reportNotAddressed(transport)).status).toBe("recorded");

    // The row is stored as an addressing report, not a complaint about the reply.
    expect(await getFeedbackRow()).toMatchObject({
      status: "completed",
      topic: "addressing",
      feedback: NOT_ADDRESSED_OPTION,
    });
    // ...and the word is excluded, with the provenance of the report on it.
    const exclusions = await listAddressingExclusions(ctx.db);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]).toMatchObject({
      term: "Георгій",
      normalized: "георгій",
      botDisplayName: "Aria",
      chatId: CHAT_ID,
      telegramMessageId: BOT_MSG_ID,
      userId: USER_ID,
    });
    // The analyzer reads it back as a plain term list.
    expect(await listAddressingExclusionTerms(ctx.db)).toEqual(["Георгій"]);
    // The whole report is one story on the feedback trace.
    const traces = await listTraces({ feature: "user-feedback" });
    const answer = traces.traces.find((t) => t.action === "answer")!;
    expect(answer.outputSummary).toContain("excluded from addressing");
    const full = await getTrace(answer.id);
    expect(full!.events.some((e) => e.message.includes("addressing exclusion recorded"))).toBe(
      true,
    );
  });

  it("keeps one row when the same word is reported again", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    const { transport } = fakeFeedbackTransport();

    await reportNotAddressed(transport);
    // A repeat reaction reopens the same feedback row; the second report lands on
    // an already-excluded word.
    const second = await reportNotAddressed(transport);

    expect(second.status).toBe("recorded");
    expect(await listAddressingExclusions(ctx.db)).toHaveLength(1);
    const traces = await listTraces({ feature: "user-feedback" });
    const answers = traces.traces.filter((t) => t.action === "answer");
    expect(answers.some((t) => t.outputSummary?.includes("excluded from addressing"))).toBe(true);
  });

  // The honest bound of the feature: an @mention, a reply, or the name spelled
  // exactly has no word that could be excluded without deafening the bot.
  it("records the complaint but excludes nothing when the bot was addressed explicitly", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "mention", matchedText: null });
    const { transport } = fakeFeedbackTransport();

    expect((await reportNotAddressed(transport)).status).toBe("recorded");

    expect(await getFeedbackRow()).toMatchObject({ topic: "addressing" });
    expect(await listAddressingExclusions(ctx.db)).toHaveLength(0);
    const traces = await listTraces({ feature: "user-feedback" });
    const answer = traces.traces.find((t) => t.action === "answer")!;
    expect(answer.outputSummary).toContain("nothing to exclude");
  });

  it("refuses to exclude the bot's own display name", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "analyzer", matchedText: "aria", botDisplayName: "Aria" });
    const { transport } = fakeFeedbackTransport();

    await reportNotAddressed(transport);

    expect(await listAddressingExclusions(ctx.db)).toHaveLength(0);
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces.find((t) => t.action === "answer")!.outputSummary).toContain(
      "own display name",
    );
  });

  // An addressing report is a routing fault, not a judgment of the reply: folding
  // it would teach style from a mis-fire (user decision, 2026-07-26).
  it("is never folded into preferences or self-corrections", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    const { transport } = fakeFeedbackTransport();
    await reportNotAddressed(transport);

    const llm = fakeFoldLlm();
    const result = await runSelfImprovement({ complete: llm.complete, db: ctx.db });

    expect(result.summary).toBe("nothing to incorporate");
    expect(llm.calls).toHaveLength(0);
    const row = await getFeedbackRow();
    expect(row).toMatchObject({ prefsVersion: null, correctionsVersion: null });
    expect(await getLatestCorrection(ctx.db)).toBeNull();
  });

  it("lets the operator undo an exclusion, making the word matchable again", async () => {
    await seedExchange();
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    const { transport } = fakeFeedbackTransport();
    await reportNotAddressed(transport);
    const [exclusion] = await listAddressingExclusions(ctx.db);

    const removed = await removeAddressingExclusion(exclusion.id, ctx.db);

    expect(removed).toMatchObject({ term: "Георгій" });
    expect(await listAddressingExclusionTerms(ctx.db)).toEqual([]);
    expect(await removeAddressingExclusion(exclusion.id, ctx.db)).toBeNull();
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces.some((t) => t.action === "exclusion-delete")).toBe(true);
  });
});
