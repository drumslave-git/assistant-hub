import { describe, expect, it } from "vitest";

import {
  expectToolCalled,
  expectToolNotCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

import { BROWSE_WEB_TOOL } from "./mcp-tools";

/**
 * Opt-in live tool-selection coverage for `browse_web`. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered
 * with a canned result — so no browser launches and no run is enqueued.
 *
 * The tool description is the one part no unit test can vouch for: its job is to
 * make the model start a browsing run for ANY web task — it is the only web tool
 * the bot has — and *not* for a fact it already knows or casual chat. Both
 * directions are asserted: a tool that fires on "cool website!" is worse than one
 * that never fires, and a bot that answers a live question from memory is worse
 * than one that goes and looks.
 *
 * All fixtures are synthetic (example.com / made-up placeholders); no real user
 * data is used.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- browser-agent/server/tool-selection`
 */
describe.skipIf(!LLM_LIVE)("browser agent tool selection (live)", () => {
  useLiveLlm();

  it(
    "browses when asked to go to a site and do something there",
    async () => {
      const run = await runToolSelection({
        userText:
          "Go to https://example.com, open its 'products' section, and tell me the name of the first product listed.",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background. Tell the user you're on it.",
            structuredContent: { ok: true, runId: "run_demo_1" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses (and carries the link) when the goal needs interaction beyond one page",
    async () => {
      const run = await runToolSelection({
        userText:
          "Go to https://example.com, follow its 'More information' link, and tell me what page it leads to.",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background.",
            structuredContent: { ok: true, runId: "run_demo_2" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
      const call = run.toolCalls.find((c) => c.name === BROWSE_WEB_TOOL);
      // The agent starts from nothing but the goal text — the link the user gave
      // must be carried into it, or the run has nowhere to begin.
      expect(String(call?.args.goal ?? "")).toContain("example.com");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses when the user gives a link and asks to download the file/video on it",
    async () => {
      // Regression: a download request must NOT be refused with "I'm just a language
      // model / can't download files" — the description asserts the capability hard
      // enough to override that false prior. The failure was about "download a file",
      // independent of the content.
      const run = await runToolSelection({
        userText: "https://example.com/clips/sample.mp4 download this video",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background.",
            structuredContent: { ok: true, runId: "run_demo_3" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses a named dynamic site for a live value a search snippet can't give",
    async () => {
      // Regression: for a live value tied to a specific named site, web search returns
      // stale/inconsistent cached snippets, so a named-site + live-value request must
      // browse and read the real rendered number.
      const run = await runToolSelection({
        userText: "how many users are online right now on stats.example.com?",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background. Tell the user you're on it; do not invent results.",
            structuredContent: { ok: true, runId: "run_demo_4" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "does not browse for a plain fact it already knows",
    async () => {
      const run = await runToolSelection({ userText: "What's the capital of France?" });
      expectToolNotCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses for a plain lookup, now that it is the only way to reach the web",
    async () => {
      // Regression for the tool-surface change (2026-07-26): with search_web and
      // read_web_page removed, an ordinary "look this up" must reach browse_web —
      // the old description told the model to prefer a plain search for exactly this.
      const run = await runToolSelection({
        userText: "look up what the current version of Node.js is",
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses for a commodity live value instead of answering from memory",
    async () => {
      const run = await runToolSelection({ userText: "what's the weather in London right now?" });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
