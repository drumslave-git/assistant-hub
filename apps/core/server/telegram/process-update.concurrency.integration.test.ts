import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { getChatHistory } from "@/features/history/server/service";
import { getKnownUser } from "@/features/known-users/server/repository";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import type { ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { barrier, deferred } from "@/test/async";
import { simulateUpdate } from "@/test/simulate";
import { startTestDb, type TestDb } from "@/test/db";

/**
 * Concurrency coverage for the transport-agnostic pipeline (IMPROVEMENTS
 * §12.1). Since the runner landed, the bot manager processes updates
 * concurrently across chats (per-chat `sequentialize`, cross-chat parallel), so
 * `processUpdate` must tolerate two updates genuinely in flight at once. These
 * tests drive real overlap through the simulator against a real Postgres:
 * generators are gated so both pipelines are provably mid-reply simultaneously,
 * then every observable side effect (mirror, known users, reply linkage,
 * traces) is checked for cross-talk and loss.
 *
 * Per-chat *ordering* is the transport edge's contract (`sequentialize`), not
 * the pipeline's — the pipeline's half of that contract is "processed in order
 * → observed in order", which the sequential same-chat test asserts.
 */

let ctx: TestDb;
let prevDatabaseUrl: string | undefined;

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  // Bind the app's own pool (used inside the pipeline) to the same container.
  process.env.DATABASE_URL = ctx.connectionUri;
});

afterAll(async () => {
  // `processUpdate` pokes the idle backfill scheduler, arming a debounce timer;
  // clear it so it doesn't keep the process alive after the suite.
  stopVisionBackfill();
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

/**
 * A deterministic reply generator that optionally blocks on `gate` after being
 * called, so a test can hold the reply mid-flight while another update runs.
 */
function gatedGenerator(content: string, gate?: () => Promise<void>) {
  const calls: ChatMessage[][] = [];
  const generateReply = async (messages: ChatMessage[]) => {
    calls.push(messages);
    await gate?.();
    return { content, model: "test-model", latencyMs: 1 };
  };
  return { generateReply, calls };
}

describe("processUpdate under concurrency", () => {
  it("handles two overlapping updates for different chats independently, with no cross-talk", async () => {
    // Neither reply resolves until both pipelines have reached their generator —
    // both updates are provably in flight at the same time.
    const bothInFlight = barrier(2);
    const genA = gatedGenerator("Reply for chat A", bothInFlight);
    const genB = gatedGenerator("Reply for chat B", bothInFlight);

    const [resA, resB] = await Promise.all([
      simulateUpdate(
        { text: "hi from chat A", chatId: 111, messageId: 11, from: { id: 100, username: "alice" } },
        { generateReply: genA.generateReply },
      ),
      simulateUpdate(
        { text: "hi from chat B", chatId: 222, messageId: 22, from: { id: 200, username: "bob" } },
        { generateReply: genB.generateReply },
      ),
    ]);

    // Each update delivered its own reply through its own sink.
    expect(resA.outcome.status).toBe("replied");
    expect(resB.outcome.status).toBe("replied");
    expect(resA.replies).toHaveLength(1);
    expect(resA.replies[0]).toContain("Reply for chat A");
    expect(resB.replies).toHaveLength(1);
    expect(resB.replies[0]).toContain("Reply for chat B");

    // Each generator ran once and saw only its own chat's conversation.
    expect(genA.calls).toHaveLength(1);
    expect(genB.calls).toHaveLength(1);
    const contextA = JSON.stringify(genA.calls[0]);
    const contextB = JSON.stringify(genB.calls[0]);
    expect(contextA).toContain("hi from chat A");
    expect(contextA).not.toContain("hi from chat B");
    expect(contextB).toContain("hi from chat B");
    expect(contextB).not.toContain("hi from chat A");

    // Both senders remembered.
    expect(await getKnownUser(ctx.db, "100")).toMatchObject({ username: "alice" });
    expect(await getKnownUser(ctx.db, "200")).toMatchObject({ username: "bob" });

    // Each chat's mirror holds exactly its own exchange. `getChatHistory` is
    // newest-first (dashboard order); reverse into transcript order to assert.
    for (const [chatId, text, reply] of [
      ["111", "hi from chat A", "Reply for chat A"],
      ["222", "hi from chat B", "Reply for chat B"],
    ] as const) {
      const transcript = (await getChatHistory(chatId, {}, ctx.db)).reverse();
      expect(transcript).toHaveLength(2);
      expect(transcript[0].role).toBe("user");
      expect(transcript[0].content).toBe(text);
      expect(transcript[1].role).toBe("assistant");
      expect(transcript[1].content).toContain(reply);
    }

    // One success trace per update, correlated to the right chat and message.
    const traces = await listTraces({ feature: "bot-messaging" });
    expect(traces.total).toBe(2);
    expect(traces.traces.every((t) => t.status === "success")).toBe(true);
    const correlations = traces.traces.map((t) => t.trigger.correlationId).sort();
    expect(correlations).toEqual(["111:11", "222:22"]);
  });

  it("keeps a chat's transcript and reply context in order when its updates are processed in order", async () => {
    // Same-chat updates arrive serialized (the runner's `sequentialize`); the
    // pipeline must then observe them in order: the second turn's LLM context
    // contains the first exchange, and the mirror reads back as a transcript.
    const gen1 = gatedGenerator("First answer");
    await simulateUpdate(
      { text: "What is the plan?", chatId: 777, messageId: 1, from: { id: 100, username: "alice" } },
      { generateReply: gen1.generateReply },
    );

    const gen2 = gatedGenerator("Second answer");
    await simulateUpdate(
      { text: "And after that?", chatId: 777, messageId: 2, from: { id: 100, username: "alice" } },
      { generateReply: gen2.generateReply },
    );

    // The second turn's context includes the first exchange, in transcript order,
    // ahead of the current question.
    const context = JSON.stringify(gen2.calls[0]);
    const question1 = context.indexOf("What is the plan?");
    const answer1 = context.indexOf("First answer");
    const question2 = context.indexOf("And after that?");
    expect(question1).toBeGreaterThanOrEqual(0);
    expect(answer1).toBeGreaterThan(question1);
    expect(question2).toBeGreaterThan(answer1);

    // Mirror reads back as the ordered transcript with intact reply linkage
    // (`getChatHistory` is newest-first; reversed into transcript order).
    const transcript = (await getChatHistory("777", {}, ctx.db)).reverse();
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(transcript.map((m) => m.telegramMessageId)).toEqual([1, 1001, 2, 1002]);
    expect(transcript[1].replyToMessageId).toBe(1);
    expect(transcript[3].replyToMessageId).toBe(2);
  });

  it("loses nothing and keeps reply linkage when same-chat updates complete out of order", async () => {
    // Two updates for one chat genuinely in flight together, with the *first*
    // message's reply forced to finish last. Global completion order is then
    // inverted; what must survive is completeness and linkage — every message
    // and reply mirrored, each reply anchored to its own incoming message.
    const firstReplyGate = deferred();
    const genSlow = gatedGenerator("Slow answer", () => firstReplyGate.promise);
    const genFast = gatedGenerator("Fast answer");

    const slow = simulateUpdate(
      { text: "slow question", chatId: 888, messageId: 5, from: { id: 100, username: "alice" } },
      { generateReply: genSlow.generateReply },
    );
    const fast = simulateUpdate(
      { text: "fast question", chatId: 888, messageId: 6, from: { id: 100, username: "alice" } },
      { generateReply: genFast.generateReply },
    );

    // The second update fully completes (reply delivered + mirrored) while the
    // first is still mid-generation; only then is the first allowed to finish.
    const resFast = await fast;
    expect(resFast.outcome.status).toBe("replied");
    firstReplyGate.resolve();
    const resSlow = await slow;
    expect(resSlow.outcome.status).toBe("replied");

    expect(resSlow.replies[0]).toContain("Slow answer");
    expect(resFast.replies[0]).toContain("Fast answer");

    // All four rows mirrored, each reply linked to its own incoming message.
    // (`getChatHistory` is newest-first; reversed into insertion order.)
    const transcript = (await getChatHistory("888", {}, ctx.db)).reverse();
    expect(transcript).toHaveLength(4);
    const byId = new Map(transcript.map((m) => [m.telegramMessageId, m]));
    expect(byId.get(5)).toMatchObject({ role: "user", content: "slow question" });
    expect(byId.get(6)).toMatchObject({ role: "user", content: "fast question" });
    expect(byId.get(1005)).toMatchObject({ role: "assistant", replyToMessageId: 5 });
    expect(byId.get(1005)?.content).toContain("Slow answer");
    expect(byId.get(1006)).toMatchObject({ role: "assistant", replyToMessageId: 6 });
    expect(byId.get(1006)?.content).toContain("Fast answer");

    // The inverted completion is visible in insertion order: the fast reply was
    // mirrored before the slow one — the overlap was real, not incidental.
    const fastIndex = transcript.findIndex((m) => m.telegramMessageId === 1006);
    const slowIndex = transcript.findIndex((m) => m.telegramMessageId === 1005);
    expect(fastIndex).toBeLessThan(slowIndex);

    // Both turns traced as successes, each under its own correlation.
    const traces = await listTraces({ feature: "bot-messaging" });
    expect(traces.total).toBe(2);
    expect(traces.traces.every((t) => t.status === "success")).toBe(true);
    const correlations = traces.traces.map((t) => t.trigger.correlationId).sort();
    expect(correlations).toEqual(["888:5", "888:6"]);
  });
});
