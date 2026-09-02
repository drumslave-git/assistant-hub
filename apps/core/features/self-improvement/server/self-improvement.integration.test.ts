import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackRecordedEvent } from "@assistant-hub-swarm/contracts";

import { ADDRESSING_CHECK_EVENT } from "@/features/bot-messaging/addressing-trace";
import {
  listAddressingExclusions,
  listAddressingExclusionTerms,
} from "@/features/bot-messaging/server/exclusions-repository";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { resetEnvCache } from "@/server/env";
import { closeStorePool } from "@/server/store/db";
import { getTrace, listTraces, startTrace } from "@/server/trace";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { communicationPreferences, selfCorrections, sourceUsers } from "../../../store/schema";

import type { UserFeedback } from "../types";
import { runSelfImprovement } from "./analyze";
import type {
  FeedbackPorts,
  FeedbackStorePort,
  SourceMessage,
  SourceMessagePort,
} from "./feedback-store";
import { handleFeedbackRecorded } from "./recorded-consumer";
import { reflectOnFeedback } from "./reflect";
import { getLatestCorrection, getLatestPreference, insertCorrection, insertPreference } from "./repository";
import { removeAddressingExclusion } from "./service";

/**
 * Integration coverage for the self-improvement learning pipeline against a
 * real Postgres (the distilled outputs — preferences, corrections,
 * exclusions — plus real traces), with the source-owned feedback rows and
 * mirror behind in-memory ports. The collection flows themselves live in
 * the tg app since the split and are covered by its feedback suite; the
 * `feedback.recorded` consumer here is where the core's learning starts.
 */

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
  // Env-bound readers (user labels via the source-store adapter) go through
  // the process-global store pool (`getStoreDb()`).
  process.env.DATABASE_URL = ctx.connectionUri;
  resetEnvCache();
});

afterAll(async () => {
  stopVisionBackfill();
  await closeStorePool();
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT_ID = "555";
const USER_ID = "100";
/** The tg menu option that files an addressing report (owned by apps/tg). */
const NOT_ADDRESSED_OPTION = "Wasn't talking to you";

/**
 * User labels resolve through the source-store adapter (`source_users`,
 * `source = 'tg'`); the flows under test expect the rows even though the
 * feedback data itself now lives behind the ports.
 */
async function seedKnownUsers(...userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await ctx.db
      .insert(sourceUsers)
      .values({ source: "tg", userId, username: `user${userId}`, firstName: `U${userId}` })
      .onConflictDoNothing();
  }
}
const USER_MSG_ID = 10;
const BOT_MSG_ID = 11;
/** A proactively-sent message (scheduled-task fire) — no reply pointer. */
const FIRED_MSG_ID = 42;

/** In-memory stand-ins for the source's feedback rows + message mirror. */
function fakePorts(): FeedbackPorts & {
  rows: Map<string, UserFeedback>;
  msgs: Map<string, SourceMessage>;
  seedExchange: () => void;
  seedCompleted: (input: {
    userId?: string;
    feedback: string;
    topic?: "quality" | "addressing";
    messageId?: number;
    reaction?: "up" | "down";
    reflection?: string | null;
  }) => UserFeedback;
} {
  const rows = new Map<string, UserFeedback>();
  const msgs = new Map<string, SourceMessage>();
  let seq = 0;

  const feedbacks: FeedbackStorePort = {
    async listAll() {
      return [...rows.values()].reverse();
    },
    async listUnincorporated(kind) {
      return [...rows.values()].filter(
        (row) =>
          row.status === "completed" &&
          row.topic === "quality" &&
          (kind === "prefs" ? row.prefsVersion == null : row.correctionsVersion == null),
      );
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async patch(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`feedback ${id} not found`);
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    },
  };
  const messages: SourceMessagePort = {
    async getMessage(chatId, sourceMessageId) {
      return msgs.get(`${chatId}:${sourceMessageId}`) ?? null;
    },
  };
  return {
    feedbacks,
    messages,
    rows,
    msgs,
    seedExchange() {
      msgs.set(`${CHAT_ID}:${USER_MSG_ID}`, {
        content: "what's the weather?",
        replyToSourceMessageId: null,
      });
      msgs.set(`${CHAT_ID}:${BOT_MSG_ID}`, {
        content: "Sunny, 25°C.",
        replyToSourceMessageId: String(USER_MSG_ID),
      });
    },
    seedCompleted(input) {
      const row: UserFeedback = {
        id: `fb-${++seq}`,
        chatId: CHAT_ID,
        telegramMessageId: input.messageId ?? BOT_MSG_ID,
        userId: input.userId ?? USER_ID,
        reaction: input.reaction ?? "down",
        feedback: input.feedback,
        status: "completed",
        topic: input.topic ?? "quality",
        model: "",
        reflection: input.reflection ?? null,
        reflectionModel: input.reflection ? "gemma3:12b" : null,
        prefsVersion: null,
        correctionsVersion: null,
        createdAt: new Date(Date.now() + seq).toISOString(),
        updatedAt: new Date(Date.now() + seq).toISOString(),
      };
      rows.set(row.id, row);
      return row;
    },
  };
}

/**
 * A deterministic "LLM" that answers by which fold prompt it was given: a
 * reflection, a preferences profile (JSON), or correction guidelines.
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

describe("self-reflection (reflectOnFeedback)", () => {
  /** The reply trace the reflection reads: how the bot produced the reacted reply. */
  async function seedReplyTrace() {
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "transport", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
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

  it("reflects from the reply trace and stores the result through the port", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "too long" });
    await seedReplyTrace();
    const reflection = "The persona demanded full background, so a one-line question got an essay.";
    const complete = vi.fn().mockResolvedValue({
      content: reflection,
      model: "docker.io/ai/gemma3:12b",
      latencyMs: 1,
    });

    const result = await reflectOnFeedback(feedback, {
      complete,
      model: "docker.io/ai/gemma3:12b",
      ports,
    });

    expect(result).toBe(reflection);
    expect(ports.rows.get(feedback.id)).toMatchObject({
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
      relatedIds: { users_feedbacks: [feedback.id] },
    });
  });

  it("reflects on a proactively-sent message from the trace that delivered it", async () => {
    // A task fire has no incoming message to key on, so it settles on
    // what it delivered — the reacted message itself, not a reply anchor.
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    ports.msgs.set(`${CHAT_ID}:${FIRED_MSG_ID}`, {
      content: "Hey. Just checking in.",
      replyToSourceMessageId: null,
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

    const feedback = ports.seedCompleted({
      feedback: "Right tone",
      reaction: "up",
      messageId: FIRED_MSG_ID,
    });
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Stayed short and unscripted.", model: "m", latencyMs: 1 });

    await reflectOnFeedback(feedback, { complete, ports });

    // The fire's own prompt reached the reflection — no reply pointer involved.
    const asked = String(complete.mock.calls[0][0].at(-1).content);
    expect(asked).toContain("Never sound scripted");
    expect(asked).toContain("Hey. Just checking in.");
  });

  it("reads the producing trace, not the feedback traces keyed on the same message", async () => {
    // The recorded/reflect traces all key on the reacted message, so an
    // unscoped "latest trace on this message" would return one of those — and a
    // second reflection would read its own previous output back to itself.
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "too long" });
    await seedReplyTrace();
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Went long.", model: "m", latencyMs: 1 });

    // Two runs: the first leaves a `reflect` trace on `CHAT_ID:BOT_MSG_ID`.
    await reflectOnFeedback(feedback, { complete, ports });
    await reflectOnFeedback(feedback, { complete, ports });

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
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "wrong tone" });
    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Answered a real question flippantly.", model: "m", latencyMs: 1 });

    await reflectOnFeedback(feedback, { complete, ports });

    // No trace to reason from — the exchange from the source's mirror stands in.
    const asked = String(complete.mock.calls[0][0].at(-1).content);
    expect(asked).toContain("what's the weather?");
    expect(asked).toContain("Sunny, 25°C.");
    expect(ports.rows.get(feedback.id)!.reflection).toBe("Answered a real question flippantly.");
    // The operator can see the reflection was the thinner kind.
    const header = (await listTraces({ feature: "user-feedback" })).traces[0];
    const events = (await getTrace(header.id))!.events;
    expect(events.some((e) => e.level === "warn" && e.message.includes("no reply trace"))).toBe(
      true,
    );
  });

  it("leaves the reflection null when the call fails, for the next incorporation run", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "too long" });
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));

    expect(await reflectOnFeedback(feedback, { complete, ports })).toBeNull();
    expect(ports.rows.get(feedback.id)).toMatchObject({
      reflection: null,
      reflectionModel: null,
    });
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces[0]).toMatchObject({ status: "skipped", action: "reflect" });
  });

  it("does not reflect on a feedback the user has not answered yet", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const pending: UserFeedback = {
      ...ports.seedCompleted({ feedback: "ignored" }),
      status: "pending",
      feedback: null,
    };
    const complete = vi.fn();

    expect(await reflectOnFeedback(pending, { complete, ports })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    // Nothing happened, so nothing is recorded — Debug stays free of noise.
    expect((await listTraces({ feature: "user-feedback" })).total).toBe(0);
  });
});

describe("daily incorporation (runSelfImprovement)", () => {
  it("folds the backlog into new preference versions per user + one correction version, stamping every feedback", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    ports.seedCompleted({ userId: "100", feedback: "too long" });
    ports.seedCompleted({ userId: "200", feedback: "wrong tone" });
    const llm = fakeFoldLlm();

    const result = await runSelfImprovement({
      complete: llm.complete,
      personalityPrompt: "You are a pirate.",
      model: "docker.io/ai/gemma3:12b",
      ports,
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
    // Both folds read the exchange from the source's mirror, and the reflection
    // the backfill wrote moments earlier.
    const prefsCall = llm.calls.find((c) => String(c[0].content).includes("factual profile"))!;
    expect(String(prefsCall.at(-1)!.content)).toContain("what's the weather?");
    expect(String(prefsCall.at(-1)!.content)).toContain("Sunny, 25°C.");
    expect(String(prefsCall.at(-1)!.content)).toContain(
      "Padded a one-line answer with background nobody asked for.",
    );
    // The reflections are written back through the port, not just passed through.
    for (const row of ports.rows.values()) {
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
    for (const row of ports.rows.values()) {
      expect(row.prefsVersion).toBe(1);
      expect(row.correctionsVersion).toBe(1);
    }
    // Traced under self-improvement with the full fold bodies.
    const traces = await listTraces({ feature: "self-improvement" });
    expect(traces.total).toBe(1);
    expect(traces.traces[0]).toMatchObject({ status: "success", action: "incorporate" });

    // A second run with nothing new is a silent no-op (no extra trace).
    const again = await runSelfImprovement({ complete: llm.complete, ports, db: ctx.db });
    expect(again.summary).toBe("nothing to incorporate");
    expect((await listTraces({ feature: "self-improvement" })).total).toBe(1);
  });

  it("skips the reflection backfill for a feedback that already has one, and folds from it", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    // The usual case: the answer was reflected on the moment it arrived.
    ports.seedCompleted({ feedback: "too long", reflection: "Buried the answer in caveats." });
    const llm = fakeFoldLlm();

    await runSelfImprovement({ complete: llm.complete, ports, db: ctx.db });

    // 1 preference fold + 1 correction fold — nothing to re-reflect.
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) {
      expect(String(call[0].content)).not.toContain("reviewing one of your own replies");
      // Both folds reason from the stored reflection, not just the user's words.
      expect(String(call.at(-1)!.content)).toContain("Buried the answer in caveats.");
    }
  });

  it("seeds the next version from the previous one", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    ports.seedCompleted({ feedback: "too long" });
    await runSelfImprovement({ complete: fakeFoldLlm().complete, ports, db: ctx.db });

    // A fresh feedback arrives later (a new bot message id to satisfy uniqueness).
    ports.msgs.set(`${CHAT_ID}:21`, {
      content: "Another reply.",
      replyToSourceMessageId: String(USER_MSG_ID),
    });
    ports.seedCompleted({ feedback: "loved the brevity", reaction: "up", messageId: 21 });

    const llm = fakeFoldLlm({ likes: "brevity", dislikes: "rambling", correction: "Keep it short." });
    await runSelfImprovement({ complete: llm.complete, ports, db: ctx.db });

    // The preference fold started from version 1's profile.
    const prefsCall = llm.calls.find((c) => String(c[0].content).includes("factual profile"))!;
    expect(String(prefsCall.at(-1)!.content)).toContain("short answers");
    expect(await getLatestPreference(ctx.db, USER_ID)).toMatchObject({ version: 2, likes: "brevity" });
    expect(await getLatestCorrection(ctx.db)).toMatchObject({ version: 2, correction: "Keep it short." });
  });

  it("leaves a feedback unstamped for the next run when its fold call fails", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "too long" });
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));

    const result = await runSelfImprovement({ complete, ports, db: ctx.db });
    expect(result.incorporated).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    expect(ports.rows.get(feedback.id)).toMatchObject({
      prefsVersion: null,
      correctionsVersion: null,
    });
    expect(await ctx.db.select().from(communicationPreferences)).toHaveLength(0);
    expect(await ctx.db.select().from(selfCorrections)).toHaveLength(0);
    // The run trace still settles (success with failure counts in the summary).
    const traces = await listTraces({ feature: "self-improvement" });
    expect(traces.total).toBe(1);
  });

  it("keeps prompt injection fed: the folds' outputs are what the reply reads", async () => {
    await seedKnownUsers(USER_ID);
    // The injection itself (correction block in the system prompt, the
    // sender's preferences as a system message) is asserted on the composed
    // prompt in the turn-consumer integration test; here the pipeline's
    // outputs land in the same tables that read serves from.
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
    expect(await getLatestPreference(ctx.db, USER_ID)).toMatchObject({ likes: "short answers" });
    expect(await getLatestCorrection(ctx.db)).toMatchObject({
      correction: "Answer in fewer words.",
    });
  });
});

describe("feedback.recorded consumer", () => {
  function recordedEvent(feedback: UserFeedback): FeedbackRecordedEvent {
    return {
      v: 1,
      eventId: `evt-${feedback.id}`,
      occurredAt: new Date().toISOString(),
      correlationId: `${feedback.chatId}:${feedback.telegramMessageId}`,
      type: "feedback.recorded",
      source: "tg",
      feedback: {
        id: feedback.id,
        chatRef: `tg:chat:${feedback.chatId}`,
        sourceMessageId: String(feedback.telegramMessageId),
        userRef: `tg:user:${feedback.userId}`,
        reaction: feedback.reaction,
        text: feedback.feedback ?? "",
        topic: feedback.topic,
      },
    };
  }

  it("stamps the reacted reply's clean model and runs the reflection", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    const feedback = ports.seedCompleted({ feedback: "too long" });
    // The reply trace (keyed by the incoming message) carries the raw model id.
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "transport", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
    });
    await trace.event({
      type: "llm_response",
      message: "response",
      usage: { model: "docker.io/ai/gemma3:12b" },
    });
    await trace.succeed();

    const complete = vi
      .fn()
      .mockResolvedValue({ content: "Went long again.", model: "m", latencyMs: 1 });
    await handleFeedbackRecorded(recordedEvent(feedback), {
      ports,
      reflection: { complete, ports },
      db: ctx.db,
    });

    expect(ports.rows.get(feedback.id)).toMatchObject({
      model: "gemma3:12b", // clean name — registry prefix stripped
      reflection: "Went long again.",
    });
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces.some((t) => t.action === "recorded" && t.status === "success")).toBe(
      true,
    );
  });

  it("skips cleanly when the row is gone from the source store", async () => {
    const ports = fakePorts();
    const ghost = ports.seedCompleted({ feedback: "gone" });
    ports.rows.delete(ghost.id);

    await handleFeedbackRecorded(recordedEvent(ghost), {
      ports,
      reflection: null,
      db: ctx.db,
    });

    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces[0]).toMatchObject({ action: "recorded", status: "skipped" });
  });
});

describe("addressing report (👎 → \"Wasn't talking to you\")", () => {
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
      trigger: { kind: "transport", actor: USER_ID, correlationId: `${CHAT_ID}:${USER_MSG_ID}` },
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

  /** The recorded addressing report, driven through the bus-event consumer. */
  async function reportNotAddressed(ports: ReturnType<typeof fakePorts>) {
    const feedback = ports.seedCompleted({
      feedback: NOT_ADDRESSED_OPTION,
      topic: "addressing",
    });
    await handleFeedbackRecorded(
      {
        v: 1,
        eventId: `evt-${feedback.id}`,
        occurredAt: new Date().toISOString(),
        correlationId: `${CHAT_ID}:${BOT_MSG_ID}`,
        type: "feedback.recorded",
        source: "tg",
        feedback: {
          id: feedback.id,
          chatRef: `tg:chat:${CHAT_ID}`,
          sourceMessageId: String(BOT_MSG_ID),
          userRef: `tg:user:${USER_ID}`,
          reaction: "down",
          text: NOT_ADDRESSED_OPTION,
          topic: "addressing",
        },
      },
      { ports, reflection: null, db: ctx.db },
    );
    return feedback;
  }

  it("files the word the analyzer matched, so it stops summoning the bot", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });

    await reportNotAddressed(ports);

    // The word is excluded, with the provenance of the report on it.
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
    // The whole report is one story on the recorded trace.
    const traces = await listTraces({ feature: "user-feedback" });
    const recorded = traces.traces.find((t) => t.action === "recorded")!;
    expect(recorded.outputSummary).toContain("excluded from addressing");
    const full = await getTrace(recorded.id);
    expect(full!.events.some((e) => e.message.includes("addressing exclusion recorded"))).toBe(
      true,
    );
  });

  it("keeps one row when the same word is reported again", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });

    await reportNotAddressed(ports);
    await reportNotAddressed(ports);

    expect(await listAddressingExclusions(ctx.db)).toHaveLength(1);
    const traces = await listTraces({ feature: "user-feedback" });
    const recorded = traces.traces.filter((t) => t.action === "recorded");
    expect(recorded.some((t) => t.outputSummary?.includes("excluded from addressing"))).toBe(true);
  });

  // The honest bound of the feature: an @mention, a reply, or the name spelled
  // exactly has no word that could be excluded without deafening the bot.
  it("records the complaint but excludes nothing when the bot was addressed explicitly", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "mention", matchedText: null });

    await reportNotAddressed(ports);

    expect(await listAddressingExclusions(ctx.db)).toHaveLength(0);
    const traces = await listTraces({ feature: "user-feedback" });
    const recorded = traces.traces.find((t) => t.action === "recorded")!;
    expect(recorded.outputSummary).toContain("nothing to exclude");
  });

  it("refuses to exclude the bot's own display name", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "analyzer", matchedText: "aria", botDisplayName: "Aria" });

    await reportNotAddressed(ports);

    expect(await listAddressingExclusions(ctx.db)).toHaveLength(0);
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces.find((t) => t.action === "recorded")!.outputSummary).toContain(
      "own display name",
    );
  });

  // An addressing report is a routing fault, not a judgment of the reply: folding
  // it would teach style from a mis-fire (user decision, 2026-07-26).
  it("is never folded into preferences or self-corrections", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    await reportNotAddressed(ports);

    const llm = fakeFoldLlm();
    const result = await runSelfImprovement({ complete: llm.complete, ports, db: ctx.db });

    expect(result.summary).toBe("nothing to incorporate");
    expect(llm.calls).toHaveLength(0);
    for (const row of ports.rows.values()) {
      expect(row).toMatchObject({ prefsVersion: null, correctionsVersion: null });
    }
    expect(await getLatestCorrection(ctx.db)).toBeNull();
  });

  it("lets the operator undo an exclusion, making the word matchable again", async () => {
    const ports = fakePorts();
    ports.seedExchange();
    await seedKnownUsers("100", "200");
    await seedAddressingTrace({ source: "analyzer", matchedText: "Георгій" });
    await reportNotAddressed(ports);
    const [exclusion] = await listAddressingExclusions(ctx.db);

    const removed = await removeAddressingExclusion(exclusion.id, ctx.db);

    expect(removed).toMatchObject({ term: "Георгій" });
    expect(await listAddressingExclusionTerms(ctx.db)).toEqual([]);
    expect(await removeAddressingExclusion(exclusion.id, ctx.db)).toBeNull();
    const traces = await listTraces({ feature: "user-feedback" });
    expect(traces.traces.some((t) => t.action === "exclusion-delete")).toBe(true);
  });
});
