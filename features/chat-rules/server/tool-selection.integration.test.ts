import { describe, expect, it } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the chat-rules MCP tools. Skipped
 * unless `LLM_LIVE=1`. Tools are never executed — each call is recorded and
 * answered with a canned result (see `runToolSelection`).
 *
 * The load-bearing case is the third one. Twice in production the bot answered a
 * standing-rule request with prose and stored nothing: first because the tools
 * were not registered on the running server (trace `7a3c354e…`), then because it
 * talked itself out of the call (trace `f33e1ede…`) on the grounds that it had
 * "already confirmed twice" and that repeating would duplicate the rule. Its own
 * earlier confirmations were in the transcript, so the poisoned transcript is
 * reproduced here verbatim as `priorTurns`.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- chat-rules/server/tool-selection`
 */
describe.skipIf(!LLM_LIVE)("chat-rules MCP tool selection (live)", () => {
  useLiveLlm();

  /** The operator's own words from the incident (trace `f33e1ede…`). */
  const RULE_REQUEST =
    "new rule - whenever you see a message with link to social network media, like x.com, " +
    "tiktok, instagram, etc - download it and send to the chat";

  it(
    "saves a standing rule when one is set",
    async () => {
      const run = await runToolSelection({ userText: RULE_REQUEST });
      expectToolCalled(run, "rules_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "marks a react-to-any-message rule as `always`",
    async () => {
      // "whenever you see a message with …" must not become an `on-reply` rule:
      // that is the whole difference between the rule working and the rule only
      // applying when somebody also addresses the bot.
      const run = await runToolSelection({ userText: RULE_REQUEST });
      const create = run.toolCalls.find((call) => call.name === "rules_create");
      expect(create?.args.trigger, `rules_create args: ${JSON.stringify(create?.args)}`).toBe(
        "always",
      );
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "still saves the rule when its own earlier replies claim it already did",
    async () => {
      // Regression, trace `f33e1ede…` (2026-07-29). The reasoning block: "since I
      // already confirmed twice… calling rules_create again for the exact same
      // text might result in duplicate rules… I will confirm." Nothing was stored.
      const run = await runToolSelection({
        userText: RULE_REQUEST,
        priorTurns: [
          { role: "user", content: `[#961] drumslave (@drumslave): ${RULE_REQUEST}` },
          {
            role: "assistant",
            content:
              "Got it. From now on, whenever you share a link to social media (X, TikTok, " +
              "Instagram, etc.), I'll download the content and send it over to the chat for you.",
          },
          { role: "user", content: `[#963] drumslave (@drumslave): ${RULE_REQUEST}` },
          {
            role: "assistant",
            content:
              "Understood, I'll make sure to download and send any social media links (X, " +
              "TikTok, Instagram, etc.) you share from now on.",
          },
        ],
      });
      expectToolCalled(run, "rules_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "saves a plain behavioural instruction as a rule, not as a memory or a task",
    async () => {
      const run = await runToolSelection({
        userText: "from now on always answer me in one short sentence, nothing longer",
      });
      expectToolCalled(run, "rules_create");
      // The two tools this is confused with: a fact about a person, or something
      // that happens at a time.
      expect(run.toolNames).not.toContain("memory_save");
      expect(run.toolNames).not.toContain("tasks_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "lists the rules when asked what it was told to do",
    async () => {
      const run = await runToolSelection({ userText: "what rules do you have in this chat?" });
      expectToolCalled(run, "rules_list");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "cancels a rule through list → delete",
    async () => {
      const run = await runToolSelection({
        userText: "forget the rule about answering briefly, drop it",
      });
      expectToolCalled(run, "rules_delete");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
