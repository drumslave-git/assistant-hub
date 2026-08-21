import { describe, it } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the history MCP tools. Skipped unless
 * `LLM_LIVE=1`. Drives the real configured LLM with the real tool schemas + the
 * production system prompt and asserts the model picks the right history tool; the
 * tools are never executed (see {@link runToolSelection}).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("history MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "searches history for something said earlier",
    async () => {
      const run = await runToolSelection({
        userText: "What did I tell you earlier about my car? Look back through our history.",
      });
      expectToolCalled(run, "history_search");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "fetches history within a date range",
    async () => {
      const run = await runToolSelection({
        userText:
          "Pull up everything we discussed between July 1st and July 3rd, 2026 and summarize it.",
      });
      expectToolCalled(run, "history_get_in_range");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "fetches a specific message by its id",
    async () => {
      const run = await runToolSelection({
        priorTurns: [
          {
            role: "user",
            content:
              "[#742] user: not sure, it's in that earlier message [reply to #500] you don't have.",
          },
        ],
        userText: "Can you look up exactly what was said in message #500?",
      });
      expectToolCalled(run, "history_get_by_message_ids");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "recalls a topic discussed months ago",
    async () => {
      const run = await runToolSelection({
        userText:
          "Months ago we had a long argument about which database library to use. What did we end up deciding?",
      });
      expectToolCalled(run, "history_recall_topics");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
