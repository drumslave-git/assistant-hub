import { describe, expect, it } from "vitest";

import {
  expectToolCalled,
  expectToolNotCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

import { IMAGE_GENERATE_TOOL } from "./mcp-tools";

/**
 * Opt-in live tool-selection coverage for `image_generate`. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered
 * with a canned result — so no image is generated and nothing is sent.
 *
 * The tool description is the one part of this feature no unit test can vouch for:
 * its whole job is to make the model draw when asked and *not* otherwise, and only
 * a real model reading it can settle that. Both directions are asserted, because
 * a tool that fires on "nice photo!" is worse than one that never fires.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- image-gen/server/tool-selection`
 */
describe.skipIf(!LLM_LIVE)("image generation tool selection (live)", () => {
  useLiveLlm();

  it(
    "draws when the user explicitly asks for a picture",
    async () => {
      const run = await runToolSelection({
        userText: "Draw me a picture of a red fox sitting in the snow at sunset.",
      });
      expectToolCalled(run, IMAGE_GENERATE_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "expands a terse request into a real prompt rather than passing it through",
    async () => {
      const run = await runToolSelection({ userText: "make me an image of a cat" });
      expectToolCalled(run, IMAGE_GENERATE_TOOL);
      const call = run.toolCalls.find((c) => c.name === IMAGE_GENERATE_TOOL);
      const prompt = String(call?.args.prompt ?? "");
      // The user's words are rarely a usable diffusion prompt; the description tells
      // the model to expand them, so a bare echo means that instruction is not landing.
      expect(prompt.length).toBeGreaterThan("make me an image of a cat".length);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "does not draw for casual chat that merely mentions a picture",
    async () => {
      const run = await runToolSelection({
        userText: "That photo you saw earlier was a really nice picture, wasn't it?",
      });
      expectToolNotCalled(run, IMAGE_GENERATE_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
