import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { fakeSourceContent, type FakeSourceContent } from "@/test/fake-source-content";
import { startTestDb, type TestDb } from "@/test/db";

import {
  countDaysNeedingSummary,
  listDaysNeedingSummary,
  runSummarization,
  summarizeChatDay,
  type SummarizeDeps,
} from "./summarize";

/**
 * The summarization JOB against a real core database (markers, traces) with
 * the source's content behind the in-memory fake: due-scan comparison → LLM
 * pass → embed → replace-day write-back → marker stamp, plus the
 * idempotency and self-healing rules the job leans on. The summaries' own
 * SQL (storage, hybrid search, the day buckets) lives with the data in the
 * tg app and is pinned by its content suite.
 */

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

const CHAT = "555";
/** "Now" for the run: the 14th, so the 13th is a finished, summarizable day. */
const NOW = new Date("2026-07-14T12:00:00.000Z");
const YESTERDAY = "2026-07-13";

/** A completion carrying `content`, shaped like the real client's result. */
function completion(content: string): ChatCompletionResult {
  return {
    content,
    model: "test-model",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    requestBody: {},
    responseBody: { choices: [{ message: { content } }] },
  };
}

/** A deterministic vector — distinct per text, so ranking is meaningful. */
function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === seed % EMBEDDING_DIMENSIONS ? 1 : 0,
  );
}

/** Deps whose model returns `topics` verbatim and whose embedder is deterministic. */
function deps(
  content: FakeSourceContent,
  overrides: Partial<SummarizeDeps> = {},
): SummarizeDeps {
  return {
    complete: vi.fn(async () =>
      completion(
        JSON.stringify({
          topics: [{ content: "They discussed the broken deploy", message_ids: [1, 2] }],
        }),
      ),
    ),
    embed: vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector(i + 1))),
    timeZone: "UTC",
    now: () => NOW,
    content,
    ...overrides,
  };
}

/** Seed a two-message exchange on the given day into the fake source. */
function seedDay(content: FakeSourceContent, date: string, startId = 1, chatId = CHAT): void {
  content.addMessage({
    chatId,
    telegramMessageId: startId,
    userId: "100",
    content: "the deploy is broken again",
    sentAt: new Date(`${date}T10:00:00.000Z`),
  });
  content.addMessage({
    chatId,
    telegramMessageId: startId + 1,
    role: "assistant",
    content: "I rolled it back",
    replyToMessageId: startId,
    sentAt: new Date(`${date}T10:00:05.000Z`),
  });
}

function pendingDays(content: FakeSourceContent, today = "2026-07-14") {
  return listDaysNeedingSummary(content, ctx.db, { timeZone: "UTC", today, limit: 10 });
}

describe("summarizeChatDay", () => {
  it("summarizes a day, embeds the topics, and stores them with their message ids", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ messageCount: 2, topicCount: 1, embedded: true });

    const stored = await content.listSummaries(CHAT);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      summaryDate: YESTERDAY,
      content: "They discussed the broken deploy",
      messageIds: [1, 2],
      embedded: true,
    });
  });

  it("shows the model an id-anchored transcript with resolved speakers", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);
    const d = deps(content);

    await summarizeChatDay({ chatId: CHAT, summaryDate: YESTERDAY }, d, { kind: "test" }, ctx.db);

    const [messages] = (d.complete as unknown as { mock: { calls: [ChatMessage[]][] } }).mock
      .calls[0];
    const prompt = messages[1].content as string;
    expect(prompt).toContain("[#1]");
    expect(prompt).toContain("the deploy is broken again");
    // The bot's own turns are labelled, so the model knows who said what.
    expect(prompt).toContain("Bot: I rolled it back");
  });

  it("is idempotent: re-summarizing a day replaces its topics rather than duplicating them", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content),
      { kind: "test" },
      ctx.db,
    );
    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, {
        complete: async () =>
          completion(JSON.stringify({ topics: [{ content: "A better summary", message_ids: [2] }] })),
      }),
      { kind: "test" },
      ctx.db,
    );

    const stored = await content.listSummaries(CHAT);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("A better summary");
  });

  it("stores the topics even when embedding fails — recall degrades, the summary is not lost", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, {
        embed: async () => {
          throw new Error("embedding endpoint down");
        },
      }),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ topicCount: 1, embedded: false });
    const stored = await content.listSummaries(CHAT);
    expect(stored[0]).toMatchObject({ content: "They discussed the broken deploy", embedded: false });
  });

  it("stores topics without vectors when no embedding model is configured", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, { embed: null }),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ topicCount: 1, embedded: false });
    expect((await content.listSummaries(CHAT))[0].embedded).toBe(false);
  });

  it("marks a day of pure noise as done, so it is never re-summarized", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, { complete: async () => completion('{"topics":[]}') }),
      { kind: "test" },
      ctx.db,
    );

    expect(await content.listSummaries(CHAT)).toHaveLength(0);
    // The marker was still written: the day no longer counts as pending work.
    expect(await pendingDays(content)).toEqual([]);
  });

  it("splits a busy day into several model passes and unions the topics", async () => {
    const content = fakeSourceContent();
    // 40 long messages blow past the batch budget.
    for (let i = 1; i <= 40; i += 1) {
      content.addMessage({
        chatId: CHAT,
        telegramMessageId: i,
        userId: "100",
        content: "x".repeat(1000),
        sentAt: new Date(`${YESTERDAY}T10:00:00.000Z`),
      });
    }
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      return completion(
        JSON.stringify({ topics: [{ content: `Topic from pass ${call}`, message_ids: [call] }] }),
      );
    });

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, { complete }),
      { kind: "test" },
      ctx.db,
    );

    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(result.topicCount).toBe(complete.mock.calls.length);
  });

  it("annotates media messages with their descriptions and drops unreadable blank lines", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);
    // #3: a photo with no caption whose image vision has described.
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 3,
      userId: "100",
      content: "",
      sentAt: new Date(`${YESTERDAY}T11:00:00.000Z`),
      media: { kind: "photo", status: "described", description: "a cat asleep on a keyboard" },
    });
    // #4: an empty row with nothing readable at all — unreadable.
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 4,
      userId: "100",
      content: "",
      sentAt: new Date(`${YESTERDAY}T11:01:00.000Z`),
    });

    const d = deps(content);
    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      d,
      { kind: "test" },
      ctx.db,
    );

    const [messages] = (d.complete as unknown as { mock: { calls: [ChatMessage[]][] } }).mock
      .calls[0];
    const prompt = messages[1].content as string;
    // The described photo reads as text; the unreadable row makes no blank line.
    expect(prompt).toContain("[photo: a cat asleep on a keyboard]");
    expect(prompt).not.toContain("[#4]");
    // The marker records the raw day count (4 rows), so the count comparison in
    // the due-scan still sees the day as unchanged.
    expect(result.messageCount).toBe(4);
    expect(await pendingDays(content)).toEqual([]);
  });

  it("recovers from a model context overflow by re-batching smaller", async () => {
    const content = fakeSourceContent();
    for (let i = 1; i <= 40; i += 1) {
      content.addMessage({
        chatId: CHAT,
        telegramMessageId: i,
        userId: "100",
        content: "x".repeat(1000),
        sentAt: new Date(`${YESTERDAY}T10:00:00.000Z`),
      });
    }
    // A model whose real context fits ~20k prompt chars: the first 24k-budget
    // batch is rejected the way llama.cpp words it (pinned live phrasing); the
    // re-batched halves fit.
    let pass = 0;
    const complete = vi.fn(async (messages: ChatMessage[]) => {
      const prompt = messages[1].content as string;
      if (prompt.length > 20_000) {
        throw new Error("LLM endpoint error (500): Context size has been exceeded.");
      }
      pass += 1;
      return completion(
        JSON.stringify({ topics: [{ content: `Topic from pass ${pass}`, message_ids: [pass] }] }),
      );
    });

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content, { complete }),
      { kind: "test" },
      ctx.db,
    );

    // Every pass eventually succeeded and the day settled — no stuck retry loop.
    expect(result.topicCount).toBe(pass);
    expect(complete.mock.calls.length).toBeGreaterThan(pass); // at least one rejection
    expect(await pendingDays(content)).toEqual([]);
  });

  it("records the run as a trace with the full request and response bodies", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);

    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content),
      { kind: "test" },
      ctx.db,
    );

    const { traces } = await listTraces({ feature: "history-summaries" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "summarize", status: "success" });
    expect(traces[0].outputSummary).toContain("1 topic(s) from 2 message(s)");
  });
});

describe("listDaysNeedingSummary", () => {
  it("offers finished days with messages, and never today", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY, 1);
    seedDay(content, "2026-07-14", 10); // today — unfinished

    const pending = await pendingDays(content);
    expect(pending).toEqual([{ chatId: CHAT, summaryDate: YESTERDAY, messageCount: 2 }]);
    expect(
      await countDaysNeedingSummary(content, ctx.db, { timeZone: "UTC", today: "2026-07-14" }),
    ).toBe(1);
  });

  it("re-offers a day that gained messages after it was summarized (a CSV import, a late edit)", async () => {
    const content = fakeSourceContent();
    seedDay(content, YESTERDAY);
    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(content),
      { kind: "test" },
      ctx.db,
    );
    expect(await pendingDays(content)).toEqual([]);

    // A late row lands in the already-summarized day.
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 3,
      userId: "100",
      content: "one more thing",
      sentAt: new Date(`${YESTERDAY}T20:00:00.000Z`),
    });
    expect(await pendingDays(content)).toEqual([
      { chatId: CHAT, summaryDate: YESTERDAY, messageCount: 3 },
    ]);
  });
});

describe("runSummarization", () => {
  it("summarizes the whole backlog, oldest day first, and is a no-op when done", async () => {
    const content = fakeSourceContent();
    seedDay(content, "2026-07-11", 1);
    seedDay(content, "2026-07-12", 10);
    seedDay(content, YESTERDAY, 20);

    const result = await runSummarization(deps(content), ctx.db);
    expect(result).toMatchObject({ days: 3, failures: 0 });
    expect((await content.listSummaries(CHAT)).map((s) => s.summaryDate).sort()).toEqual([
      "2026-07-11",
      "2026-07-12",
      YESTERDAY,
    ]);

    const again = await runSummarization(deps(content), ctx.db);
    expect(again.summary).toBe("nothing to summarize");
  });

  it("keeps going when one day fails, and leaves that day pending for the next run", async () => {
    const content = fakeSourceContent();
    seedDay(content, "2026-07-12", 1);
    seedDay(content, YESTERDAY, 10);

    const complete = vi.fn(async (messages: ChatMessage[]) => {
      const prompt = messages[1].content as string;
      if (prompt.includes("2026-07-12")) throw new Error("provider down");
      return completion(
        JSON.stringify({ topics: [{ content: "The good day", message_ids: [10] }] }),
      );
    });
    const result = await runSummarization(deps(content, { complete }), ctx.db);

    expect(result).toMatchObject({ days: 1, failures: 1 });
    // The failed day is still owed; the summarized one is not.
    expect(await pendingDays(content)).toEqual([
      { chatId: CHAT, summaryDate: "2026-07-12", messageCount: 2 },
    ]);
  });
});
