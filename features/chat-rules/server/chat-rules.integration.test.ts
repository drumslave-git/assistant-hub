import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  recordGroupMembership,
  upsertKnownGroup,
} from "@/features/known-groups/server/repository";
import { upsertKnownUser } from "@/features/known-users/server/repository";
import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { MAX_RULES_PER_SCOPE } from "./schema";
import {
  createChatRule,
  createRuleFromChat,
  deleteRuleFromChat,
  editChatRule,
  getActiveRulesForChat,
  getChatRulesView,
  getRulesForChat,
  removeChatRule,
  updateRuleFromChat,
} from "./service";

/**
 * Chat rules against a real database: scope resolution (a chat sees its own
 * rules plus the global ones), the per-scope cap and duplicate guard, and the
 * chat-side permission gate — self-serve in a DM, owner-only in a group, and
 * global rules read-only from any chat.
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

const trigger = { kind: "dashboard" } as const;
const chatTrigger = { kind: "telegram", actor: "100", correlationId: "100" } as const;

/** A group chat id (negative) and DM ids (positive, equal to the user id). */
const GROUP = "-1001";
const DM_USER = "100";
const OTHER_USER = "200";

function create(over: Partial<Parameters<typeof createChatRule>[0]> = {}) {
  return createChatRule(
    {
      chatId: GROUP,
      text: "Answer briefly.",
      trigger: "on-reply",
      enabled: true,
      targetUserIds: [],
      ...over,
    },
    trigger,
    ctx.db,
  );
}

/**
 * A rule can only name people the bot has seen speak in the group, so a test
 * about targeting has to put them on the roster first.
 */
async function joinGroup(chatId: string, ...userIds: string[]) {
  await upsertKnownGroup(ctx.db, { chatId, title: "Test group", type: "supergroup" });
  for (const userId of userIds) {
    await upsertKnownUser(ctx.db, {
      userId,
      username: null,
      firstName: `User ${userId}`,
      lastName: null,
    });
    await recordGroupMembership(ctx.db, chatId, userId);
  }
}

describe("scopes", () => {
  it("gives a chat its own rules plus the global ones, and nobody else's", async () => {
    const own = await create({ chatId: GROUP, text: "Answer briefly." });
    const global = await create({ chatId: null, text: "Never swear." });
    await create({ chatId: "-2002", text: "Somebody else's rule." });

    const rules = await getRulesForChat(GROUP, ctx.db);

    expect(rules.map((r) => r.id).sort()).toEqual([own.id, global.id].sort());
  });

  it("separates the reply set from the `always` set, dropping disabled rules from both", async () => {
    await create({ text: "Answer briefly." });
    await create({ text: "Download video links.", trigger: "always" });
    await create({ text: "Paused rule.", enabled: false });
    await create({ text: "Paused always rule.", trigger: "always", enabled: false });

    const { reply, always } = await getActiveRulesForChat(GROUP, DM_USER, ctx.db);

    expect(reply.map((r) => r.text)).toEqual(["Answer briefly.", "Download video links."]);
    expect(always.map((r) => r.text)).toEqual(["Download video links."]);
  });

  it("returns rules oldest first, so the order they were agreed in is the order they read in", async () => {
    const first = await create({ text: "First." });
    const second = await create({ text: "Second." });

    expect((await getRulesForChat(GROUP, ctx.db)).map((r) => r.id)).toEqual([first.id, second.id]);
  });
});

describe("dashboard CRUD", () => {
  it("creates, edits and deletes, recording a trace for each", async () => {
    const rule = await create();
    await editChatRule(rule.id, { text: "Answer very briefly." }, trigger, ctx.db);
    await removeChatRule(rule.id, trigger, ctx.db);

    expect(await getChatRulesView(ctx.db)).toEqual([]);
    const { traces } = await listTraces({ feature: "chat-rules" });
    expect(traces.map((t) => t.action).sort()).toEqual(["create", "delete", "update"]);
    expect(traces.every((t) => t.status === "success")).toBe(true);
  });

  it("links the rule id on the trace so Debug can find it", async () => {
    const rule = await create();
    const { traces } = await listTraces({ feature: "chat-rules" });
    expect(traces[0]?.relatedIds?.chat_rules).toEqual([rule.id]);
  });

  it("refuses a duplicate rule in the same scope, but allows it in another", async () => {
    await create({ text: "Answer briefly." });
    await expect(create({ text: "answer BRIEFLY." })).rejects.toMatchObject({ status: 409 });
    await expect(create({ chatId: null, text: "Answer briefly." })).resolves.toBeTruthy();
  });

  it("caps each scope independently", async () => {
    for (let i = 0; i < MAX_RULES_PER_SCOPE; i++) {
      await create({ text: `Rule ${i}.` });
    }
    await expect(create({ text: "One too many." })).rejects.toMatchObject({ status: 409 });
    // The global scope still has room of its own.
    await expect(create({ chatId: null, text: "Global rule." })).resolves.toBeTruthy();
  });

  it("rejects an update to an unknown rule", async () => {
    await expect(
      editChatRule("nope", { text: "x" }, trigger, ctx.db),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("chat-side permission gate", () => {
  it("lets a user set a rule in their own DM", async () => {
    const result = await createRuleFromChat(
      { chatId: DM_USER, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(result.status).toBe("created");
    const rules = await getRulesForChat(DM_USER, ctx.db);
    expect(rules[0]).toMatchObject({ source: "chat", createdByUserId: DM_USER, enabled: true });
  });

  it("is idempotent from chat: the same rule again succeeds and stores nothing new", async () => {
    // The dashboard gets a 409 for a duplicate (an operator must see the no-op),
    // but from chat a repeat is the state the person asked for. A tool that
    // errored here is what taught the model to answer in prose instead of
    // calling it (trace `f33e1ede…`).
    const first = await createRuleFromChat(
      { chatId: DM_USER, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );
    const again = await createRuleFromChat(
      { chatId: DM_USER, userId: DM_USER, text: "  answer BRIEFLY.  ", trigger: "always" },
      chatTrigger,
      ctx.db,
    );

    expect(first.status).toBe("created");
    expect(again.status).toBe("exists");
    // The stored rule is returned untouched — a repeat never silently rewrites it.
    expect(again).toMatchObject({ rule: { trigger: "on-reply", text: "Answer briefly." } });
    expect(await getRulesForChat(DM_USER, ctx.db)).toHaveLength(1);
  });

  it("refuses a repeat before it checks for duplicates when the caller may not write", async () => {
    // Order matters: an outsider must not learn what a chat's rules are by
    // watching "created" turn into "exists".
    await createRuleFromChat(
      { chatId: DM_USER, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    const result = await createRuleFromChat(
      { chatId: DM_USER, userId: OTHER_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({ status: "denied" });
  });

  it("refuses someone writing into a DM that is not theirs", async () => {
    const result = await createRuleFromChat(
      { chatId: DM_USER, userId: OTHER_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(await getRulesForChat(DM_USER, ctx.db)).toEqual([]);
  });

  it("allows only the configured owner to write in a group", async () => {
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });

    const denied = await createRuleFromChat(
      { chatId: GROUP, userId: OTHER_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );
    const allowed = await createRuleFromChat(
      { chatId: GROUP, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(denied).toMatchObject({ status: "denied" });
    expect(allowed.status).toBe("created");
  });

  it("refuses a group write when no owner is configured", async () => {
    const result = await createRuleFromChat(
      { chatId: GROUP, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({ status: "denied" });
  });

  it("cannot see or touch another chat's rule", async () => {
    const other = await create({ chatId: "-2002", text: "Somebody else's rule." });
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });

    const updated = await updateRuleFromChat(
      { chatId: GROUP, userId: DM_USER, id: other.id, patch: { text: "mine now" } },
      chatTrigger,
      ctx.db,
    );
    const deleted = await deleteRuleFromChat(
      { chatId: GROUP, userId: DM_USER, id: other.id },
      chatTrigger,
      ctx.db,
    );

    expect(updated).toEqual({ status: "not_found" });
    expect(deleted).toEqual({ status: "not_found" });
    expect((await getRulesForChat("-2002", ctx.db))[0].text).toBe("Somebody else's rule.");
  });

  it("shows a global rule to the chat but refuses to change it from there", async () => {
    const global = await create({ chatId: null, text: "Never swear." });
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });

    expect((await getRulesForChat(GROUP, ctx.db)).map((r) => r.id)).toContain(global.id);
    const result = await deleteRuleFromChat(
      { chatId: GROUP, userId: DM_USER, id: global.id },
      chatTrigger,
      ctx.db,
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(result).toMatchObject({ reason: expect.stringMatching(/every chat/i) });
    expect((await getChatRulesView(ctx.db)).map((r) => r.id)).toContain(global.id);
  });

  it("pauses a rule from chat without deleting it", async () => {
    const rule = await createRuleFromChat(
      { chatId: DM_USER, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply" },
      chatTrigger,
      ctx.db,
    );
    expect(rule.status).toBe("created");

    const paused = await updateRuleFromChat(
      {
        chatId: DM_USER,
        userId: DM_USER,
        id: rule.status === "created" ? rule.rule.id : "",
        patch: { enabled: false },
      },
      chatTrigger,
      ctx.db,
    );

    expect(paused).toMatchObject({ status: "updated" });
    expect((await getActiveRulesForChat(DM_USER, DM_USER, ctx.db)).reply).toEqual([]);
    expect(await getRulesForChat(DM_USER, ctx.db)).toHaveLength(1);
  });
});

/**
 * A group rule can apply to everyone there or only to the people it names (user
 * decision, 2026-08-13). Naming people is a hard filter on the sender, applied
 * before anything reaches a prompt — so the model is never handed a rule about
 * somebody else and asked to work out that it does not apply.
 */
describe("who a rule applies to", () => {
  const ALICE = "11";
  const BOB = "22";

  it("hands a targeted rule only to the people it names", async () => {
    await joinGroup(GROUP, ALICE, BOB);
    await create({ text: "Everyone's rule." });
    await create({ text: "Alice's rule.", targetUserIds: [ALICE] });

    const forAlice = await getActiveRulesForChat(GROUP, ALICE, ctx.db);
    const forBob = await getActiveRulesForChat(GROUP, BOB, ctx.db);

    expect(forAlice.reply.map((r) => r.text)).toEqual(["Everyone's rule.", "Alice's rule."]);
    expect(forBob.reply.map((r) => r.text)).toEqual(["Everyone's rule."]);
    // The full set is unchanged — targeting narrows the turn, not the chat's rules.
    expect(await getRulesForChat(GROUP, ctx.db)).toHaveLength(2);
  });

  it("drops a targeted `always` rule for everyone else, so it can never open their turn", async () => {
    await joinGroup(GROUP, ALICE, BOB);
    await create({ text: "Download Alice's links.", trigger: "always", targetUserIds: [ALICE] });

    expect((await getActiveRulesForChat(GROUP, ALICE, ctx.db)).always).toHaveLength(1);
    expect((await getActiveRulesForChat(GROUP, BOB, ctx.db)).always).toEqual([]);
  });

  it("drops targeted rules from a turn with no sender (a scheduled-task fire)", async () => {
    await joinGroup(GROUP, ALICE);
    await create({ text: "Everyone's rule." });
    await create({ text: "Alice's rule.", targetUserIds: [ALICE] });

    const fired = await getActiveRulesForChat(GROUP, null, ctx.db);

    expect(fired.reply.map((r) => r.text)).toEqual(["Everyone's rule."]);
  });

  it("refuses to name someone the bot has never seen speak in the group", async () => {
    await joinGroup(GROUP, ALICE);

    await expect(create({ targetUserIds: [BOB] })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to name anyone in a DM or in the global set", async () => {
    await expect(
      create({ chatId: DM_USER, targetUserIds: [DM_USER] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(create({ chatId: null, targetUserIds: [DM_USER] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("edits who a rule applies to, and can widen it back to everyone", async () => {
    await joinGroup(GROUP, ALICE, BOB);
    const rule = await create({ targetUserIds: [ALICE] });

    await editChatRule(rule.id, { targetUserIds: [ALICE, BOB] }, trigger, ctx.db);
    expect((await getActiveRulesForChat(GROUP, BOB, ctx.db)).reply).toHaveLength(1);

    await editChatRule(rule.id, { targetUserIds: [] }, trigger, ctx.db);
    expect((await getActiveRulesForChat(GROUP, "999", ctx.db)).reply).toHaveLength(1);
  });

  it("amends the audience when the same rule is set again from chat for other people", async () => {
    // Not "already in force": the people are the one thing that differs, so
    // reporting it unchanged would be a lie about exactly what was asked for.
    await joinGroup(GROUP, ALICE, BOB);
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const first = await createRuleFromChat(
      { chatId: GROUP, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply", targetUserIds: [ALICE] },
      chatTrigger,
      ctx.db,
    );
    const again = await createRuleFromChat(
      { chatId: GROUP, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply", targetUserIds: [ALICE, BOB] },
      chatTrigger,
      ctx.db,
    );
    const repeat = await createRuleFromChat(
      { chatId: GROUP, userId: DM_USER, text: "Answer briefly.", trigger: "on-reply", targetUserIds: [BOB, ALICE] },
      chatTrigger,
      ctx.db,
    );

    expect(first.status).toBe("created");
    expect(again).toMatchObject({ status: "updated", rule: { targetUserIds: [ALICE, BOB] } });
    // The same people again, in another order, is the state already reached.
    expect(repeat.status).toBe("exists");
    expect(await getRulesForChat(GROUP, ctx.db)).toHaveLength(1);
  });
});
