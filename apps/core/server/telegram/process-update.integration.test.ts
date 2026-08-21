import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import type { NameMatch } from "@/features/bot-messaging/server/address-analyzer";
import { getChatHistory } from "@/features/history/server/service";
import { getKnownUser } from "@/features/known-users/server/repository";
import { upsertSettings } from "@/features/settings/server/repository";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import type { ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { simulateUpdate } from "@/test/simulate";
import { startTestDb, type TestDb } from "@/test/db";

/**
 * End-to-end flow test for the message pipeline, driven with no Telegram bot: a
 * synthetic update runs through the real {@link processUpdate} (via the
 * simulator harness) against a real Postgres. The bot's LLM is injected
 * deterministically, so this asserts the *runtime glue* the service unit tests
 * can't reach — passive capture, history mirroring, addressing, delivery, and
 * trace recording — all writing through the app's own `getDb()`.
 *
 * The pipeline uses `getDb()`/`getPool()` internally, so we point the app pool at
 * this container by setting `DATABASE_URL` before the first query.
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

/** A deterministic reply generator + a record of the message lists it saw. */
function fakeGenerator(content = "Hi there!") {
  const calls: ChatMessage[][] = [];
  const generateReply = async (messages: ChatMessage[]) => {
    calls.push(messages);
    return { content, model: "test-model", latencyMs: 1 };
  };
  return { generateReply, calls };
}

/**
 * A deterministic addressing analyzer answering with one classification, so a
 * group message the cheap checks leave undecided settles without a provider.
 */
function fakeAnalyzer(nameMatch: NameMatch) {
  const calls: ChatMessage[][] = [];
  const analyzeAddressing = async (messages: ChatMessage[]) => {
    calls.push(messages);
    return { content: JSON.stringify({ name_match: nameMatch }), model: "test-model", latencyMs: 1 };
  };
  return { analyzeAddressing, calls };
}

describe("processUpdate (bot-less flow)", () => {
  it("handles a private message end to end: remembers, mirrors, replies, traces", async () => {
    const gen = fakeGenerator("Hello back");
    const res = await simulateUpdate(
      { text: "hi bot", chatId: 777, from: { id: 100, username: "alice", firstName: "Alice" } },
      { generateReply: gen.generateReply },
    );

    // Delivered a reply through the capturing sink.
    expect(res.outcome.status).toBe("replied");
    expect(res.replies).toHaveLength(1);
    expect(res.replies[0]).toContain("Hello back");
    expect(res.typingCalls).toBeGreaterThanOrEqual(1);
    expect(gen.calls).toHaveLength(1);

    // Sender remembered — through the pipeline's own getDb().
    expect(await getKnownUser(ctx.db, "100")).toMatchObject({ userId: "100", username: "alice" });

    // Both turns mirrored into history (incoming + reply).
    const history = await getChatHistory("777", {}, ctx.db);
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.role).sort()).toEqual(["assistant", "user"]);

    // The reply was traced under bot-messaging (change-gated passive capture may
    // also write its own known-users capture trace — scope to the reply feature).
    const botTraces = await listTraces({ feature: "bot-messaging" });
    expect(botTraces.total).toBe(1);
    expect(botTraces.traces[0]).toMatchObject({ status: "success" });
  });

  it("ignores un-addressed group chatter but still captures it passively", async () => {
    const gen = fakeGenerator();
    // Plain chatter names nothing recognizable, so the cheap checks leave it to
    // the analyzer; it answers "absent" and the bot stays silent.
    const analyzer = fakeAnalyzer("absent");
    const res = await simulateUpdate(
      {
        text: "just chatting",
        chatId: -1001,
        chatType: "supergroup",
        chatTitle: "Test Group",
        from: { id: 200, username: "bob", firstName: "Bob" },
      },
      { generateReply: gen.generateReply, analyzeAddressing: analyzer.analyzeAddressing },
    );

    expect(res.outcome).toMatchObject({
      status: "ignored",
      reason: "not_addressed",
      source: "analyzer",
    });
    expect(res.replies).toEqual([]);
    expect(gen.calls).toHaveLength(0);
    expect(analyzer.calls).toHaveLength(1);

    // Passive capture runs regardless of addressing: user remembered + mirrored.
    expect(await getKnownUser(ctx.db, "200")).not.toBeNull();
    expect(await getChatHistory("-1001", {}, ctx.db)).toHaveLength(1);

    // The bot asked the LLM about this message before staying silent, so the
    // operator gets one trace explaining the silence — settled as skipped, not
    // dropped. (Chatter the cheap checks reject outright leaves nothing behind.)
    const botTraces = await listTraces({ feature: "bot-messaging" });
    expect(botTraces.total).toBe(1);
    expect(botTraces.traces[0]).toMatchObject({
      status: "skipped",
      outputSummary: "not addressed — display name absent",
    });
  });

  it("replies in a group when @mentioned", async () => {
    const gen = fakeGenerator("Group answer");
    const res = await simulateUpdate(
      {
        text: "@SimBot what's up",
        chatId: -1002,
        chatType: "supergroup",
        from: { id: 300, firstName: "Carol" },
      },
      { generateReply: gen.generateReply },
    );

    expect(res.outcome.status).toBe("replied");
    expect(res.replies[0]).toContain("Group answer");
    expect(gen.calls).toHaveLength(1);
  });

  it("turns away a non-owner in maintenance mode without generating a reply", async () => {
    await upsertSettings(ctx.db, { ownerUserId: "999", maintenanceModeEnabled: true });

    const gen = fakeGenerator();
    const res = await simulateUpdate(
      { text: "hi", chatId: 888, from: { id: 100, username: "alice" } },
      { generateReply: gen.generateReply },
    );

    expect(res.outcome).toMatchObject({ status: "ignored", reason: "maintenance_mode" });
    // The user is told it's maintenance (a notice, not silence), but no LLM ran.
    expect(res.replies).toHaveLength(1);
    expect(res.replies[0].toLowerCase()).toContain("maintenance");
    expect(gen.calls).toHaveLength(0);
  });

  it("lets the owner through in maintenance mode", async () => {
    await upsertSettings(ctx.db, { ownerUserId: "100", maintenanceModeEnabled: true });

    const gen = fakeGenerator("Owner reply");
    const res = await simulateUpdate(
      { text: "status?", chatId: 888, from: { id: 100, username: "alice" } },
      { generateReply: gen.generateReply },
    );

    expect(res.outcome.status).toBe("replied");
    expect(res.replies[0]).toContain("Owner reply");
    expect(gen.calls).toHaveLength(1);
  });
});
