import { describe, it, vi } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

// Curated directory edits land at the source first (the tg service owns
// the directory since the split); mocked so these tests assert the local
// shadow behavior without a live service.
vi.mock("@/server/source/tg-operator", () => ({
  writeSourceUser: vi.fn(),
  writeSourceChat: vi.fn(),
}));

/**
 * Opt-in live tool-selection coverage for the known-users MCP tool. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered with
 * a canned result (see {@link runToolSelection}).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("known-users MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "records a newly mentioned nickname for a participant",
    async () => {
      const run = await runToolSelection({
        // A DM identity context gives the model a person to attach the nickname to.
        systemContext: ["You are chatting privately with Alex (@alex)."],
        userText: "By the way, all my friends call me Sasha — remember that.",
      });
      expectToolCalled(run, "update_user_aliases");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    // Live defect (2026-08-19): this exact shape chose `memory_save` 6/6 times, so
    // the alias table — which mention matching reads — never learned the name.
    "records a name mapping ('when I say X I mean Y') as an alias, not a memory note",
    async () => {
      const run = await runToolSelection({
        systemContext: [
          "You are in the group chat \"Weekend plans\". Members: Alex (@alex), Marta (@marta).",
        ],
        userText: "When I say Sanya I mean Alex, keep that in mind.",
      });
      expectToolCalled(run, "update_user_aliases");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
