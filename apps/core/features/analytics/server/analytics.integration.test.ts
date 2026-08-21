import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces, startTrace } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { guessMapping } from "@/features/history/csv";
import { importHistoryCsv } from "@/features/history/server/transfer";

import { getMetricTotals, getModels, getMoodForPeriod, getSeries } from "./metrics";
import { regenerateAnalyticsInsights, runAnalyticsInsights } from "./insights";
import { getPeriodInsight } from "./repository";
import { resetInsightScanFloor } from "./watermark";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  // The due-scan floor lives on globalThis and would otherwise carry proof from
  // one test's data into the next test's freshly-truncated database.
  resetInsightScanFloor();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedMessage(input: {
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId?: string | null;
  content: string;
  sentAt: Date;
}) {
  await ctx.db.insert(chatMessages).values({
    chatId: input.chatId,
    telegramMessageId: input.telegramMessageId,
    role: input.role,
    userId: input.userId ?? null,
    content: input.content,
    sentAt: input.sentAt,
  });
}

/**
 * Record a real trace carrying one LLM round.
 *
 * Written through the recorder rather than inserted into a table, because that is
 * now the only place this data lives: analytics reads the trace files, so a test
 * that seeded rows directly would be testing a path production does not have. The
 * clock is faked so the trace lands in a chosen period.
 */
async function seedLlmCall(input: {
  at: Date;
  model: string;
  latencyMs: number;
  tokens: { p: number; c: number };
  callKind?: string;
  feature?: string;
  action?: string;
  actor?: string;
  correlationId?: string;
  status?: "success" | "error";
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(input.at);
  try {
    const trace = await startTrace({
      feature: input.feature ?? "bot-messaging",
      action: input.action ?? "reply",
      trigger: { kind: "telegram", actor: input.actor, correlationId: input.correlationId },
    });
    await trace.event({
      type: "llm_response",
      message: "response",
      data: {},
      usage: {
        model: input.model,
        callKind: input.callKind ?? "reply-final",
        promptTokens: input.tokens.p,
        completionTokens: input.tokens.c,
        totalTokens: input.tokens.p + input.tokens.c,
        latencyMs: input.latencyMs,
      },
    });
    if (input.status === "error") await trace.fail(new Error("boom"));
    else await trace.succeed();
  } finally {
    vi.useRealTimers();
  }
}

/** A stub that answers the hour and roll-up prompts with valid JSON. */
function stubComplete(overrides?: { hour?: string; rollup?: string }) {
  return async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
    const user = String(messages[1]?.content ?? "");
    const isHour = user.includes("Conversation (one hour)");
    const content = isHour
      ? overrides?.hour ??
        '{"moodScore":70,"moodLabel":"positive","moodSummary":"good chat","topTopic":"weekend","word":"weekend"}'
      : overrides?.rollup ?? '{"topicIndex":1,"wordIndex":1}';
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: 15,
      requestBody: {},
      responseBody: {},
    };
  };
}

describe("period bounding", () => {
  const JULY_15 = new Date("2026-07-15T10:00:00Z");
  const JULY_02 = new Date("2026-07-02T10:00:00Z");

  it("counts only the selected day, not everything up to now", async () => {
    // The regression this whole rework exists for: the old window was "the last N
    // buckets ending now" with no upper bound, so Day and Month returned identical
    // totals whenever all the data was recent.
    await seedLlmCall({ at: JULY_02, model: "m", latencyMs: 100, tokens: { p: 10, c: 5 } });
    await seedLlmCall({ at: JULY_15, model: "m", latencyMs: 100, tokens: { p: 70, c: 35 } });

    const day = await getMetricTotals({ unit: "day", anchor: "2026-07-15" }, ctx.db);
    const month = await getMetricTotals({ unit: "month", anchor: "2026-07" }, ctx.db);

    expect(day.totals.tokensProcessed).toBe(70);
    expect(month.totals.tokensProcessed).toBe(80);
    expect(day.totals.tokensProcessed).toBeLessThan(month.totals.tokensProcessed);
  });

  it("excludes the instant the next period starts", async () => {
    // Half-open bounds: the boundary belongs to exactly one period, never both.
    await seedLlmCall({
      at: new Date("2026-07-16T00:00:00Z"),
      model: "m",
      latencyMs: 10,
      tokens: { p: 999, c: 0 },
    });
    const day = await getMetricTotals({ unit: "day", anchor: "2026-07-15" }, ctx.db);
    expect(day.totals.tokensProcessed).toBe(0);

    const next = await getMetricTotals({ unit: "day", anchor: "2026-07-16" }, ctx.db);
    expect(next.totals.tokensProcessed).toBe(999);
  });

  it("lets an earlier period be navigated to, not just the latest", async () => {
    await seedLlmCall({ at: JULY_02, model: "m", latencyMs: 10, tokens: { p: 42, c: 0 } });
    const past = await getMetricTotals({ unit: "day", anchor: "2026-07-02" }, ctx.db);
    expect(past.totals.tokensProcessed).toBe(42);
    expect(past.anchor).toBe("2026-07-02");
  });
});

describe("traffic totals", () => {
  it("reports handled, replied and failed from the traces themselves", async () => {
    const at = new Date("2026-07-15T10:00:00Z");
    await seedLlmCall({ at, model: "m", latencyMs: 10, tokens: { p: 1, c: 1 }, actor: "u1" });
    await seedLlmCall({ at, model: "m", latencyMs: 10, tokens: { p: 1, c: 1 }, actor: "u2" });
    await seedLlmCall({
      at,
      model: "m",
      latencyMs: 10,
      tokens: { p: 1, c: 1 },
      actor: "u2",
      status: "error",
    });

    const t = await getMetricTotals({ unit: "day", anchor: "2026-07-15" }, ctx.db);
    expect(t.totals.handled).toBe(3);
    expect(t.totals.replied).toBe(2);
    expect(t.totals.failed).toBe(1);
    expect(t.totals.activeUsers).toBe(2);
  });

  it("scopes to one chat by the trace's correlation id", async () => {
    const at = new Date("2026-07-15T10:00:00Z");
    await seedLlmCall({
      at,
      model: "m",
      latencyMs: 10,
      tokens: { p: 40, c: 10 },
      correlationId: "c1:1",
    });
    await seedLlmCall({
      at,
      model: "m",
      latencyMs: 10,
      tokens: { p: 99, c: 99 },
      correlationId: "c2:1",
    });

    const m = await getMetricTotals({ unit: "day", anchor: "2026-07-15", chatId: "c1" }, ctx.db);
    expect(m.scope).toBe("chat");
    expect(m.totals.tokensProcessed).toBe(40);
    expect(m.totals.tokensGenerated).toBe(10);
  });
});

describe("getSeries", () => {
  it("plots a day as its 24 hours, with values on the right hour", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "hello",
      sentAt: new Date("2026-07-15T09:30:00Z"),
    });
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 2,
      role: "assistant",
      content: "hi",
      sentAt: new Date("2026-07-15T09:31:00Z"),
    });

    const s = await getSeries({ unit: "day", anchor: "2026-07-15", section: "volume" }, ctx.db);
    expect(s.bucketUnit).toBe("hour");
    expect(s.buckets).toHaveLength(24);
    expect(s.buckets[0]).toBe("2026-07-15 00");

    // The JS-built axis and the Postgres to_char key must agree, or the value joins
    // onto nothing and silently disappears.
    const human = s.series.find((x) => x.name === "From users");
    expect(human?.data).toHaveLength(24);
    expect(human?.data[9]).toBe(1);
    expect(human?.data[10]).toBe(0);
  });

  it("plots a year as its 12 months", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "hello",
      sentAt: new Date("2026-03-15T09:30:00Z"),
    });
    const s = await getSeries({ unit: "year", anchor: "2026", section: "volume" }, ctx.db);
    expect(s.bucketUnit).toBe("month");
    expect(s.buckets).toHaveLength(12);
    const human = s.series.find((x) => x.name === "From users");
    expect(human?.data[2]).toBe(1);
  });

  it("plots tokens from the traces on the same axis", async () => {
    await seedLlmCall({
      at: new Date("2026-07-15T14:00:00Z"),
      model: "m",
      latencyMs: 10,
      tokens: { p: 30, c: 12 },
    });
    const s = await getSeries({ unit: "day", anchor: "2026-07-15", section: "tokens" }, ctx.db);
    expect(s.series.find((x) => x.name === "Processed")?.data[14]).toBe(30);
    expect(s.series.find((x) => x.name === "Generated")?.data[14]).toBe(12);
  });
});

describe("getModels", () => {
  it("separates every kind of call, so one slow kind cannot hide in another", async () => {
    const at = new Date("2026-07-15T10:00:00Z");
    // One model doing three unlike jobs within one message-handling flow.
    await seedLlmCall({
      at,
      model: "docker.io/ai/gemma3:12b",
      latencyMs: 400,
      tokens: { p: 20, c: 5 },
      callKind: "addressing-check",
    });
    await seedLlmCall({
      at,
      model: "gemma3:12b",
      latencyMs: 12_000,
      tokens: { p: 900, c: 40 },
      callKind: "reply-tool-turn",
    });
    await seedLlmCall({
      at,
      model: "gemma3:12b",
      latencyMs: 2000,
      tokens: { p: 100, c: 150 },
      callKind: "reply-final",
    });

    const { models } = await getModels({ unit: "day", anchor: "2026-07-15" }, ctx.db);

    // Registry-prefixed variants merge into one clean model name.
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model.model).toBe("gemma3:12b");
    expect(model.calls).toBe(3);

    const byKind = Object.fromEntries(model.callKinds.map((k) => [k.callKind, k]));
    // The addressing check is visible at all — it used to be folded into the reply.
    expect(byKind["addressing-check"].calls).toBe(1);
    expect(byKind["addressing-check"].avgLatencyMs).toBe(400);
    // A tool turn is measured apart from the answer it led to.
    expect(byKind["reply-tool-turn"].avgLatencyMs).toBe(12_000);
    expect(byKind["reply-final"].avgLatencyMs).toBe(2000);

    // Ordered by total time contributed — the bottleneck first.
    expect(model.callKinds[0].callKind).toBe("reply-tool-turn");
  });

  it("reports percentiles per kind, so a mean cannot hide the tail", async () => {
    const at = new Date("2026-07-15T10:00:00Z");
    for (const latency of [100, 100, 100, 100, 9000]) {
      await seedLlmCall({
        at,
        model: "m",
        latencyMs: latency,
        tokens: { p: 1, c: 1 },
        callKind: "reply-final",
      });
    }
    const { models } = await getModels({ unit: "day", anchor: "2026-07-15" }, ctx.db);
    const kind = models[0].callKinds[0];
    expect(kind.latencyP50).toBe(100);
    expect(kind.latencyP95).toBe(9000);
  });
});

describe("runAnalyticsInsights", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  async function seedFinishedHour(chatId = "c1", telegramMessageId = 1) {
    await seedMessage({
      chatId,
      telegramMessageId,
      role: "user",
      userId: "u1",
      content: "planning the weekend trip",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    await seedMessage({
      chatId,
      telegramMessageId: telegramMessageId + 1,
      role: "assistant",
      content: "sounds fun!",
      sentAt: new Date("2026-07-14T09:01:00Z"),
    });
  }

  it("scores a finished hour and rolls it up the calendar, and traces the run", async () => {
    await seedFinishedHour();

    const result = await runAnalyticsInsights({
      complete: stubComplete(),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });

    expect(result.unitsComputed).toBe(1);
    // hour + day + week + month + year + all, for the one chat.
    expect(result.periodsComputed).toBe(6);

    const all = await getPeriodInsight(ctx.db, {
      granularity: "all",
      bucket: "all",
      chatId: "c1",
    });
    expect(all?.wordOfPeriod).toBe("weekend");
    expect(all?.moodScore).toBe(70);

    // The hour row is written too, so mood reads are uniform at every grain.
    const hour = await getPeriodInsight(ctx.db, {
      granularity: "hour",
      bucket: "2026-07-14 09",
      chatId: "c1",
    });
    expect(hour?.moodScore).toBe(70);
    expect(hour?.messageCount).toBe(2);

    const runTraces = await listTraces({ feature: "analytics-insights" });
    expect(runTraces.traces).toHaveLength(1);
    expect(runTraces.traces[0].status).toBe("success");
  });

  it("keeps each chat's insight separate — there is no cross-chat average", async () => {
    await seedFinishedHour("c1", 1);
    await seedFinishedHour("c2", 10);

    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    for (const chatId of ["c1", "c2"]) {
      const day = await getPeriodInsight(ctx.db, {
        granularity: "day",
        bucket: "2026-07-14",
        chatId,
      });
      expect(day?.messageCount, chatId).toBe(2);
      expect(day?.sourceUnits, chatId).toBe(1);
    }
  });

  it("weights a period's mood by messages, level by level", async () => {
    // Two hours in one day: a quiet unhappy one and a busy happy one. The day's mood
    // must follow the messages, not the hour count.
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "this is broken and I am annoyed",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    for (let i = 0; i < 9; i += 1) {
      await seedMessage({
        chatId: "c1",
        telegramMessageId: 10 + i,
        role: "user",
        userId: "u1",
        content: "great, thanks, this is lovely",
        sentAt: new Date("2026-07-14T11:00:00Z"),
      });
    }

    let call = 0;
    const complete = async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
      const user = String(messages[1]?.content ?? "");
      const isHour = user.includes("Conversation (one hour)");
      // First hour scored is 09:00 (1 message, mood 10); second is 11:00 (9, mood 90).
      const content = isHour
        ? (call++ === 0
            ? '{"moodScore":10,"moodLabel":"negative","moodSummary":"x","topTopic":"a bug","word":"bug"}'
            : '{"moodScore":90,"moodLabel":"positive","moodSummary":"y","topTopic":"a fix","word":"fix"}')
        : '{"topicIndex":2,"wordIndex":2}';
      return {
        content,
        model: "test-model",
        latencyMs: 5,
        requestBody: {},
        responseBody: {},
      };
    };

    await runAnalyticsInsights({ complete, timeZone: "UTC", now: NOW, db: ctx.db });

    const day = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      chatId: "c1",
    });
    // (10*1 + 90*9) / 10 = 82 — not the 50 an unweighted mean would give.
    expect(day?.moodScore).toBe(82);
    expect(day?.sourceUnits).toBe(2);
  });

  it("gives the Mood tile and the Mood trend the same answer for a period", async () => {
    await seedFinishedHour();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const mood = await getMoodForPeriod(
      { unit: "day", anchor: "2026-07-14", chatId: "c1" },
      ctx.db,
    );

    // The tile's number and the chart's points come from one call, so they cannot
    // disagree — and the tile is the weighted mean of exactly the points drawn.
    expect(mood.aggregate?.moodScore).toBe(70);
    const scored = mood.points.filter((p) => p.moodScore != null);
    expect(scored).toHaveLength(1);
    expect(scored[0].bucket).toBe("2026-07-14 09");
    expect(scored[0].moodScore).toBe(70);

    // And the chart series reads through the same function.
    const series = await getSeries(
      { unit: "day", anchor: "2026-07-14", section: "mood", chatId: "c1" },
      ctx.db,
    );
    expect(series.series[0].data[9]).toBe(70);
    // An unscored hour is a gap, not a mood of zero.
    expect(series.series[0].data[10]).toBeNull();
  });

  it("chooses the top topic from the sub-periods, never inventing an umbrella phrase", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "about the migration",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 2,
      role: "user",
      userId: "u1",
      content: "about the outage",
      sentAt: new Date("2026-07-14T11:00:00Z"),
    });

    let call = 0;
    const complete = async (messages: ChatMessage[]): Promise<ChatCompletionResult> => {
      const user = String(messages[1]?.content ?? "");
      const isHour = user.includes("Conversation (one hour)");
      const content = isHour
        ? (call++ === 0
            ? '{"moodScore":50,"moodLabel":"neutral","moodSummary":"x","topTopic":"database migration","word":"migration"}'
            : '{"moodScore":50,"moodLabel":"neutral","moodSummary":"y","topTopic":"the outage","word":"outage"}')
        : // A model trying to summarize instead of choosing. The index parse rejects
          // it, and the deterministic fallback picks a real observed topic.
          '{"topicIndex":"miscellaneous topics","wordIndex":"various"}';
      return { content, model: "test-model", latencyMs: 5, requestBody: {}, responseBody: {} };
    };

    await runAnalyticsInsights({ complete, timeZone: "UTC", now: NOW, db: ctx.db });

    const day = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      chatId: "c1",
    });
    expect(["database migration", "the outage"]).toContain(day?.topTopic);
    expect(["migration", "outage"]).toContain(day?.wordOfPeriod);
  });

  it("is idempotent — an unchanged hour is not recomputed", async () => {
    await seedFinishedHour();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const again = await runAnalyticsInsights({
      complete: stubComplete(),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });
    expect(again.unitsComputed).toBe(0);
    expect(again.summary).toContain("nothing to compute");
  });

  it("does not re-score a scored hour when its message count changes", async () => {
    await seedFinishedHour();
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    // A late message lands in an already-scored hour. A scored hour is final until an
    // operator asks for it again, so the nightly spend stays predictable.
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 99,
      role: "user",
      userId: "u1",
      content: "one more thing",
      sentAt: new Date("2026-07-14T09:30:00Z"),
    });
    const again = await runAnalyticsInsights({
      complete: stubComplete(),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });
    expect(again.unitsComputed).toBe(0);
  });

  it("excludes the in-progress hour", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "still talking",
      sentAt: new Date("2026-07-15T12:30:00Z"),
    });
    const result = await runAnalyticsInsights({
      complete: stubComplete(),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });
    expect(result.unitsComputed).toBe(0);
  });

  it("fails closed — a garbled model response leaves the hour unstored", async () => {
    await seedFinishedHour();

    const result = await runAnalyticsInsights({
      complete: stubComplete({ hour: "not valid json" }),
      timeZone: "UTC",
      now: NOW,
      db: ctx.db,
    });
    expect(result.unitsComputed).toBe(0);
    expect(result.unitsFailed).toBe(1);

    const all = await getPeriodInsight(ctx.db, { granularity: "all", bucket: "all", chatId: "c1" });
    expect(all).toBeNull();
  });
});

describe("regenerateAnalyticsInsights", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");

  async function seedHour(iso: string, chatId = "c1", id = 1) {
    await seedMessage({
      chatId,
      telegramMessageId: id,
      role: "user",
      userId: "u1",
      content: "planning the weekend trip",
      sentAt: new Date(iso),
    });
  }

  const NEGATIVE =
    '{"moodScore":20,"moodLabel":"negative","moodSummary":"bad","topTopic":"delays","word":"delays"}';

  it("drops an hour's insights and computes them again", async () => {
    await seedHour("2026-07-14T09:00:00Z");
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    // Re-scored with a different mood, proving it was really re-read rather than
    // left alone as an already-scored hour.
    const result = await regenerateAnalyticsInsights(
      { complete: stubComplete({ hour: NEGATIVE }), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "day", bucket: "2026-07-14" },
    );

    expect(result.unitsComputed).toBe(1);
    const day = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-07-14",
      chatId: "c1",
    });
    expect(day?.moodScore).toBe(20);
    expect(day?.wordOfPeriod).toBe("delays");
  });

  it("rebuilds the wider roll-ups that contained the dropped hour", async () => {
    await seedHour("2026-07-14T09:00:00Z");
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    await regenerateAnalyticsInsights(
      { complete: stubComplete({ hour: NEGATIVE }), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "day", bucket: "2026-07-14" },
    );

    // Every period covering that hour would otherwise be a stale claim about a score
    // that no longer exists.
    for (const [granularity, bucket] of [
      ["hour", "2026-07-14 09"],
      ["week", "2026-07-13"],
      ["month", "2026-07"],
      ["year", "2026"],
      ["all", "all"],
    ] as const) {
      const row = await getPeriodInsight(ctx.db, { granularity, bucket, chatId: "c1" });
      expect(row?.moodScore, `${granularity} ${bucket}`).toBe(20);
    }
  });

  it("leaves other chats' roll-ups alone when they had no activity in the period", async () => {
    // Found live: regenerating one day erased the month/year/all-time rows of chats
    // that were not even active that day. Only the regenerated chat's hours get
    // re-armed, so those rows had nothing left to rebuild them — silent data loss
    // recoverable only by re-scoring all history.
    await seedHour("2026-07-14T09:00:00Z", "c1", 1);
    await seedHour("2026-06-10T09:00:00Z", "c2", 2);
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const before = await getPeriodInsight(ctx.db, {
      granularity: "all",
      bucket: "all",
      chatId: "c2",
    });
    expect(before).not.toBeNull();

    // c2 has no hour on 2026-07-14, so nothing of its own became stale.
    await regenerateAnalyticsInsights(
      { complete: stubComplete({ hour: NEGATIVE }), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "day", bucket: "2026-07-14" },
    );

    for (const granularity of ["all", "year", "month"] as const) {
      const bucket = granularity === "all" ? "all" : granularity === "year" ? "2026" : "2026-06";
      const row = await getPeriodInsight(ctx.db, { granularity, bucket, chatId: "c2" });
      expect(row, `c2 ${granularity}`).not.toBeNull();
      expect(row?.moodScore, `c2 ${granularity}`).toBe(70);
    }

    // The regenerated chat did get its overlapping roll-ups rebuilt.
    const c1 = await getPeriodInsight(ctx.db, { granularity: "all", bucket: "all", chatId: "c1" });
    expect(c1?.moodScore).toBe(20);
  });

  it("leaves hours outside the dropped period untouched", async () => {
    await seedHour("2026-06-10T09:00:00Z", "c1", 1);
    await seedHour("2026-07-14T09:00:00Z", "c1", 2);
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const result = await regenerateAnalyticsInsights(
      { complete: stubComplete({ hour: NEGATIVE }), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "month", bucket: "2026-07" },
    );

    expect(result.unitsComputed).toBe(1);
    const june = await getPeriodInsight(ctx.db, {
      granularity: "day",
      bucket: "2026-06-10",
      chatId: "c1",
    });
    expect(june?.moodScore).toBe(70);
  });

  it("all/all re-scores the whole history", async () => {
    await seedHour("2026-06-10T09:00:00Z", "c1", 1);
    await seedHour("2026-07-14T09:00:00Z", "c1", 2);
    await runAnalyticsInsights({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

    const result = await regenerateAnalyticsInsights(
      { complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db },
      { granularity: "all", bucket: "all" },
    );
    expect(result.unitsComputed).toBe(2);
  });
});

describe("insight due-scan floor", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");
  const deps = () => ({ complete: stubComplete(), timeZone: "UTC", now: NOW, db: ctx.db });

  it("skips hours below the floor until something resets it", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "early chat",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    const first = await runAnalyticsInsights(deps());
    expect(first.unitsComputed).toBe(1);

    // A row lands in an hour older than the backlog window, via a direct DB
    // write — the one path with no reset hook. The floor hides it…
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 2,
      role: "user",
      userId: "u1",
      content: "ancient row",
      sentAt: new Date("2026-07-12T08:00:00Z"),
    });
    const second = await runAnalyticsInsights(deps());
    expect(second.summary).toBe("nothing to compute");

    // …and a reset (what import and regenerate do) makes it owed again.
    resetInsightScanFloor();
    const third = await runAnalyticsInsights(deps());
    expect(third.unitsComputed).toBe(1);
  });

  it("still finds a late-delivered message within the Telegram backlog window", async () => {
    // An empty run advances the floor as far as it may go: 25 h behind now.
    const empty = await runAnalyticsInsights(deps());
    expect(empty.summary).toBe("nothing to compute");

    // A backlogged update lands 16 h in the past — inside the safety margin.
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "delivered late",
      sentAt: new Date("2026-07-14T20:00:00Z"),
    });
    const result = await runAnalyticsInsights(deps());
    expect(result.unitsComputed).toBe(1);
  });

  it("is reset by a history CSV import, so imported old hours get scored", async () => {
    await runAnalyticsInsights(deps());

    const headers = ["chat_id", "telegram_message_id", "role", "content", "sent_at"];
    const csv = [headers.join(","), "c9,50,user,imported oldie,2026-07-10T09:00:00Z"].join("\n");
    const imported = await importHistoryCsv(
      { csv, mapping: guessMapping(headers) },
      { kind: "test" },
      ctx.db,
    );
    expect(imported.imported).toBe(1);

    const result = await runAnalyticsInsights(deps());
    expect(result.unitsComputed).toBe(1);
    const hour = await getPeriodInsight(ctx.db, {
      granularity: "hour",
      bucket: "2026-07-10 09",
      chatId: "c9",
    });
    expect(hour?.moodScore).toBe(70);
  });

  it("is reset by a regenerate, so its dropped hours are re-scored", async () => {
    await seedMessage({
      chatId: "c1",
      telegramMessageId: 1,
      role: "user",
      userId: "u1",
      content: "planning the weekend trip",
      sentAt: new Date("2026-07-14T09:00:00Z"),
    });
    await runAnalyticsInsights(deps());
    // A second, empty run advances the floor past the scored hour.
    await runAnalyticsInsights(deps());

    const regen = await regenerateAnalyticsInsights(deps(), {
      granularity: "hour",
      bucket: "2026-07-14 09",
    });
    // Re-scored only because regenerate dropped the floor along with the rows.
    expect(regen.unitsComputed).toBe(1);
  });
});
