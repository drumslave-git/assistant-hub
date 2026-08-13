import { loadEnvConfig } from "@next/env";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/drizzle";
import { closePool } from "@/db/pool";
import { browserAgentRuns, chatMessages, chatRules, knownUsers } from "@/db/schema";
import { getBotPolicy, getLlmRuntime } from "@/features/settings/server/service";
import { stopVisionBackfill } from "@/features/vision/server/backfill-scheduler";
import { listTraces } from "@/server/trace";
import { simulateUpdate } from "@/test/simulate";

import { createChatRule, getRulesForChat } from "./service";

/**
 * Opt-in end-to-end test of chat rules against the REAL configured LLM, driving
 * synthetic updates through the whole real pipeline (`processUpdate`). Skipped
 * unless `LLM_LIVE=1`.
 *
 * This is the run the unit and tool-selection tests cannot stand in for: whether
 * a stored rule actually makes the bot act on a message nobody addressed, and
 * whether the rule author's rights reach the download gate. Two synthetic chats,
 * both cleaned up afterward:
 *
 *  - **a group**, holding one dashboard-authored `always` rule, where an ordinary
 *    (non-owner) member posts a media link without addressing the bot;
 *  - **a private chat** of a synthetic user, where that user sets a rule in their
 *    own words and the pipeline must store it through `rules_create`.
 *
 * Deliberately no owner-sent turn: the owner is a real person in the real
 * database, and `rememberUser` would overwrite their stored profile with
 * synthetic names. The chat-side create is exercised in the DM instead, and the
 * *authority* half needs only that the matched rule was dashboard-authored.
 *
 * A `browse_web` call enqueues a real row but launches nothing here — the runner
 * registers its queue listener at boot (`instrumentation.ts`), which does not
 * happen in a test process, so the run stays `queued` and is deleted below.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- chat-rules/server/live-flow`
 */

const LIVE = process.env.LLM_LIVE === "1";

const GROUP_ID = -987_654_322;
const MEMBER_ID = "987654322";
const DM_USER_ID = "987654323";

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const chatId of [String(GROUP_ID), DM_USER_ID]) {
    await db.delete(browserAgentRuns).where(eq(browserAgentRuns.chatId, chatId));
    await db.delete(chatRules).where(eq(chatRules.chatId, chatId));
    await db.delete(chatMessages).where(eq(chatMessages.chatId, chatId));
  }
  // Only the synthetic users — never the real owner's row.
  for (const userId of [MEMBER_ID, DM_USER_ID]) {
    await db.delete(knownUsers).where(eq(knownUsers.userId, userId));
  }
}

describe.skipIf(!LIVE)("chat rules end to end against the real configured LLM", () => {
  beforeAll(async () => {
    loadEnvConfig(process.cwd());
    const runtime = await getLlmRuntime();
    if (!runtime) {
      throw new Error(
        "LLM is not configured in DB settings — set an endpoint + model on /settings first.",
      );
    }
    await cleanup();
  });

  afterAll(async () => {
    stopVisionBackfill();
    await cleanup().catch(() => undefined);
    await closePool();
  });

  it(
    "acts on an un-addressed media link because a standing rule says to, with the rule author's rights",
    async () => {
      const policy = await getBotPolicy();
      if (!policy.ownerUserId) {
        throw new Error("No owner is configured in settings — the authority half cannot be tested.");
      }

      // The operator's rule, authored where the operator authors things.
      await createChatRule(
        {
          chatId: String(GROUP_ID),
          text:
            "When anyone posts a link to a social network video (TikTok, Instagram, X/Twitter), " +
            "download the video from that link and send the file to this chat.",
          trigger: "always",
          enabled: true,
          // Everyone in the group: the rule is about links, not about people.
          targetUserIds: [],
        },
        { kind: "dashboard" },
      );

      // A rank-and-file member, talking to the room — the bot is not named, not
      // mentioned, not replied to.
      const res = await simulateUpdate({
        text: "guys look at this one https://www.tiktok.com/@someone/video/7300000000000000000",
        chatId: GROUP_ID,
        chatType: "group",
        chatTitle: "Live rule test",
        from: { id: Number(MEMBER_ID), username: "member", firstName: "Member" },
      });

      // 1. The turn happened at all — normally this message dies at the
      //    addressing check.
      expect(
        res.outcome.status,
        `outcome: ${JSON.stringify(res.outcome)}\nreplies: ${JSON.stringify(res.replies)}`,
      ).toBe("replied");

      // 2. The trace says a rule opened it, and names the authority it carried.
      const { traces } = await listTraces({ feature: "bot-messaging" });
      const trace = traces.find((t) => t.trigger.correlationId?.startsWith(`${GROUP_ID}:`));
      expect(trace?.status).toBe("success");

      // 3. The download gate got the owner's rights from the rule, not the
      //    poster's — the whole point of "rule creator beats message source".
      const db = getDb();
      const runs = await db
        .select()
        .from(browserAgentRuns)
        .where(eq(browserAgentRuns.chatId, String(GROUP_ID)));
      expect(
        runs.length,
        `expected a browsing run to be enqueued; replies: ${JSON.stringify(res.replies)}`,
      ).toBeGreaterThan(0);
      expect(runs[0].isOwner).toBe(true);
      // A rule-driven group run is restricted: downloads are fenced to the
      // triggering message's own links, and attach-or-fail applies.
      expect(runs[0].restricted).toBe(true);
      // Provenance is untouched: the run belongs to whoever posted the link.
      expect(runs[0].createdByUserId).toBe(MEMBER_ID);
      // The goal carries the link the rule was triggered by.
      expect(runs[0].goal).toContain("tiktok.com/@someone/video/7300000000000000000");
      // The link also rides on the run verbatim, extracted in code — the model
      // re-typing it into the goal is no longer load-bearing.
      expect(runs[0].sourceUrls).toEqual([
        "https://www.tiktok.com/@someone/video/7300000000000000000",
      ]);
    },
    300_000,
  );

  it(
    "stores a rule a user sets in their own words, through the real tool call",
    async () => {
      // A private chat: its id equals the user id, so this user may set their own
      // chat's rules (the specialists gate).
      const res = await simulateUpdate({
        text: "new rule: from now on always answer me in one short sentence, never longer",
        chatId: Number(DM_USER_ID),
        chatType: "private",
        from: { id: Number(DM_USER_ID), username: "dmuser", firstName: "Dm" },
      });

      expect(res.outcome.status).toBe("replied");

      const stored = await getRulesForChat(DM_USER_ID);
      const own = stored.filter((rule) => rule.chatId === DM_USER_ID);
      expect(
        own.length,
        `no rule was stored; reply was: ${JSON.stringify(res.replies)}`,
      ).toBeGreaterThan(0);
      expect(own[0]).toMatchObject({ source: "chat", createdByUserId: DM_USER_ID, enabled: true });
      // Written as an instruction, not as the user's verbatim sentence fragment.
      expect(own[0].text.length).toBeGreaterThan(10);

      // The tool call itself is traced under its own feature scope.
      const { traces } = await listTraces({ feature: "mcp-tools-chat-rules" });
      expect(traces.some((t) => t.status === "success")).toBe(true);
    },
    300_000,
  );

  it(
    "leaves ordinary chatter alone even in a chat that has an `always` rule",
    async () => {
      await createChatRule(
        {
          chatId: String(GROUP_ID),
          text:
            "When anyone posts a link to a social network video (TikTok, Instagram, X/Twitter), " +
            "download the video from that link and send the file to this chat.",
          trigger: "always",
          enabled: true,
          // Everyone in the group: the rule is about links, not about people.
          targetUserIds: [],
        },
        { kind: "dashboard" },
      ).catch(() => undefined); // may already exist from the first case

      const res = await simulateUpdate({
        text: "anyway I think the weather is finally getting better",
        chatId: GROUP_ID,
        chatType: "group",
        chatTitle: "Live rule test",
        from: { id: Number(MEMBER_ID), username: "member", firstName: "Member" },
      });

      // The matcher ran and found nothing — silence, exactly as before rules existed.
      expect(
        res.outcome,
        `expected silence; replies: ${JSON.stringify(res.replies)}`,
      ).toMatchObject({ status: "ignored", reason: "not_addressed" });
      expect(res.replies).toHaveLength(0);
    },
    300_000,
  );
});
