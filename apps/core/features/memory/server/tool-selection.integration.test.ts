import { describe, it } from "vitest";

import {
  expectToolCalled,
  expectToolNotCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the memory MCP tools. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered
 * with a canned result (see {@link runToolSelection}).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("memory MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    // Guards the alias carve-out in `memory_save`'s description: the EXCEPTION
    // clause must not scare the model off saving an ordinary durable fact.
    "still saves a durable personal fact to memory",
    async () => {
      const run = await runToolSelection({
        systemContext: ["You are chatting privately with Alex (@alex)."],
        userText: "Remember that I'm allergic to peanuts.",
      });
      expectToolCalled(run, "memory_save");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    // The other half of the 2026-08-19 defect: a pure name mapping must not be
    // filed as a free-text memory note (recognition never reads memory).
    "does not save a name mapping as a memory note",
    async () => {
      const run = await runToolSelection({
        systemContext: [
          "You are in the group chat \"Weekend plans\". Members: Alex (@alex), Marta (@marta).",
        ],
        userText: "When I say Sanya I mean Alex, keep that in mind.",
      });
      expectToolNotCalled(run, "memory_save");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
