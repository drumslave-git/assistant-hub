import { fileURLToPath } from "node:url";

import {
  inboundMessageEventSchema,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import type { ChatMessage } from "@/server/llm/client";

import { createTurnActionMarkers } from "./actions";
import { handleInboundJob, type TurnConsumerContext } from "./consume";

const V1_MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const STORE_MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/** A fully-addressed synthetic inbound event (invented ids/names only). */
function inboundEvent(overrides?: {
  addressed?: boolean;
  needsAnalyzer?: boolean;
  eventId?: string;
}): InboundMessageEvent {
  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: overrides?.eventId ?? "evt-1",
    occurredAt: new Date().toISOString(),
    correlationId: "-300:11",
    type: "message.inbound",
    source: "tg",
    assistantId: "assistant-1",
    connection: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
    chat: {
      ref: "tg:chat:-300",
      kind: "group",
      title: "Fixture Group",
      notes: "seeded for the consumer test",
      language: "English",
    },
    sender: {
      ref: "tg:user:5001",
      isOwner: false,
      label: "Alice (@alice_example)",
      username: "alice_example",
      aliases: ["Al"],
    },
    addressing: {
      addressed: overrides?.addressed ?? true,
      source: overrides?.addressed === false ? null : "mention",
      needsAnalyzer: overrides?.needsAnalyzer ?? false,
    },
    message: {
      sourceMessageId: "11",
      content: "@fixture_bot what did Bob say?",
      sentAt: new Date().toISOString(),
      replyTo: {
        sourceMessageId: "10",
        stored: true,
        senderLabel: "Bob (@bob_example)",
        text: "earlier chatter",
      },
    },
    context: {
      history: [
        {
          sourceMessageId: "10",
          role: "user",
          senderRef: "tg:user:5002",
          senderLabel: "Bob (@bob_example)",
          content: "earlier chatter",
          sentAt: new Date(Date.now() - 60_000).toISOString(),
          botReaction: "👍",
        },
        {
          sourceMessageId: "9",
          role: "assistant",
          senderRef: null,
          senderLabel: null,
          content: "an earlier reply",
          sentAt: new Date(Date.now() - 120_000).toISOString(),
        },
      ],
      participants: [
        { ref: "tg:user:5001", label: "Alice (@alice_example)", aliases: ["Al"] },
        { ref: "tg:user:5002", label: "Bob (@bob_example)", aliases: [] },
      ],
    },
  });
}

describe("inbound turn consumer", () => {
  let pg: TestPostgres;
  let storePool: Pool;
  let published: unknown[];
  let reEnqueued: Array<{ eventId: string; attempt: number }>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const v1Url = await pg.createDatabase("v1_brain");
    const storeUrl = await pg.createDatabase("core_store");
    await applyMigrations(v1Url, V1_MIGRATIONS);
    await applyMigrations(storeUrl, STORE_MIGRATIONS);
    // The brain services (policy, persona, memory, tasks) read the v1 DB via
    // the app's own pool; the markers live in the v2 store.
    process.env.DATABASE_URL = v1Url;
    process.env.STORE_DATABASE_URL = storeUrl;
    storePool = new Pool({ connectionString: storeUrl });
  });

  afterAll(async () => {
    await storePool?.end();
    await closePool();
    await pg?.stop();
  });

  beforeEach(async () => {
    published = [];
    reEnqueued = [];
    await storePool.query(`DELETE FROM turn_actions`);
  });

  function ctx(overrides?: TurnConsumerContext["overrides"]): TurnConsumerContext {
    return {
      publish: async (payload) => {
        published.push(payload);
      },
      markers: createTurnActionMarkers(storePool),
      reEnqueue: async (event, attempt) => {
        reEnqueued.push({ eventId: event.eventId, attempt });
      },
      overrides,
    };
  }

  it("runs an addressed turn: composed context in, delivery + lifecycle out, marker cleared", async () => {
    const seen: ChatMessage[][] = [];
    const result = await handleInboundJob(inboundEvent(), 1, ctx({
      generateReply: async (messages) => {
        seen.push(messages);
        return { content: "the consumer answer", model: "fixture-model", latencyMs: 1 };
      },
    }));

    expect(result.status).toBe("handled");
    expect(result.status === "handled" && result.outcome.status).toBe("replied");

    // Lifecycle + delivery, in order: accepted → delivery → settled.
    const types = published.map((p) => (p as { type: string; phase?: string }));
    expect(types.map((p) => p.phase ?? p.type)).toEqual([
      "accepted",
      "reply.delivery",
      "settled",
    ]);
    const delivery = replyDeliveryEventSchema.parse(published[1]);
    expect(delivery).toMatchObject({
      chatRef: "tg:chat:-300",
      assistantId: "assistant-1",
      replyToSourceMessageId: "11",
      text: "the consumer answer",
      correlationId: "-300:11",
    });
    for (const lifecycle of [published[0], published[2]]) {
      expect(turnLifecycleEventSchema.parse(lifecycle)).toMatchObject({
        chatRef: "tg:chat:-300",
        sourceMessageId: "11",
      });
    }

    // The prompt was composed from the event: v1 transcript format with the
    // event-supplied labels, reactions, and reply anchors; the roster block
    // carries the participants and notes.
    const messages = seen[0];
    const transcript = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[#10]"),
    );
    expect(transcript?.content).toContain(
      "[#10] Bob (@bob_example): earlier chatter [you reacted: 👍]",
    );
    expect(transcript?.content).toContain("[#9] You (@fixture_bot): an earlier reply");
    const roster = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("Known participants"),
    );
    expect(roster?.content).toContain("Alice (@alice_example) [user id 5001] — also known as: Al");
    expect(roster?.content).toContain("About this group: seeded for the consumer test");
    const currentTurn = messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("[#11]"),
    );
    expect(currentTurn?.content).toBe(
      '[#11] Alice (@alice_example) [reply to #10]: @fixture_bot what did Bob say?',
    );

    // The send marked the turn as acted, and the terminal settle cleared it.
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  it("ignores an unaddressed turn but still settles it (the source releases its hold)", async () => {
    const result = await handleInboundJob(
      inboundEvent({ addressed: false, needsAnalyzer: false, eventId: "evt-2" }),
      1,
      ctx({
        generateReply: async () => {
          throw new Error("must not generate for an unaddressed turn");
        },
      }),
    );
    expect(result.status === "handled" && result.outcome.status).toBe("ignored");
    // No typing for chatter nobody addressed — only the settle.
    expect(
      published.map((p) => (p as { phase?: string; type: string }).phase ?? (p as { type: string }).type),
    ).toEqual(["settled"]);
  });

  it("delivers the v1 error notice on a generation failure — an action, so no retry", async () => {
    const result = await handleInboundJob(inboundEvent({ eventId: "evt-err" }), 1, ctx({
      generateReply: async () => {
        throw new Error("provider exploded");
      },
    }));
    // The service catches its own turn errors and apologizes in-chat (v1
    // behavior); that send IS an action, so the job is handled, not retried.
    expect(result.status === "handled" && result.outcome.status).toBe("error");
    expect(reEnqueued).toEqual([]);
    const delivery = published.find((p) => (p as { type: string }).type === "reply.delivery");
    expect(replyDeliveryEventSchema.parse(delivery).text.length).toBeGreaterThan(0);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  const failingRunTurn = async (): Promise<never> => {
    throw new Error("infrastructure failure before the turn ran");
  };

  it("re-enqueues a pre-action failure without settling the turn", async () => {
    const result = await handleInboundJob(
      inboundEvent({ eventId: "evt-3" }),
      1,
      ctx(),
      failingRunTurn,
    );
    expect(result.status).toBe("retried");
    expect(reEnqueued).toEqual([{ eventId: "evt-3", attempt: 2 }]);
    // The turn is still live: no settled event, so the source keeps its
    // mirror hold in place until a later attempt settles.
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).not.toContain("settled");
  });

  it("never retries once the turn has acted: fails, settles, clears", async () => {
    const event = inboundEvent({ eventId: "evt-4" });
    const context = ctx();
    // An action started (a tool began, a send left) before the failure.
    await context.markers.mark(event.correlationId);

    await expect(handleInboundJob(event, 1, context, failingRunTurn)).rejects.toThrow(
      "infrastructure failure",
    );
    expect(reEnqueued).toEqual([]);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  it("fails for good when tries run out, even without actions", async () => {
    await expect(
      handleInboundJob(inboundEvent({ eventId: "evt-5" }), 5, ctx(), failingRunTurn),
    ).rejects.toThrow("infrastructure failure");
    expect(reEnqueued).toEqual([]);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
  });
});
