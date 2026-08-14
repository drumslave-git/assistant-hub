import "server-only";

import { randomInt } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { chanceOutcome, MAX_PERCENT, MIN_PERCENT, ROLL_STEPS } from "../chance";

/**
 * The randomness toolkit: one tool that settles "should this happen this time?".
 *
 * It exists because a standing task is routinely written as a probability —
 * "from time to time", "in 30% of cases", "with 70% probability" — and there is
 * no honest way for a language model to answer that itself. Asked to "decide
 * randomly", a model does not sample; it produces whatever its decoding happens
 * to favour, which is neither the requested rate nor stable across turns. Worse,
 * nothing in the trace afterwards can tell a real 30% from a model that simply
 * felt agreeable that day.
 *
 * So the roll moves into code, where it is uniform, and into the trace, where the
 * rolled number is recorded next to the threshold it was compared against.
 *
 * The tool takes the percentage and answers HIT or MISS and nothing else (user
 * decision, 2026-08-14: bare verdict). What to *do* about a miss belongs to the
 * task's own instruction — the tool has no idea what was at stake and would be
 * inventing consequences if it said.
 */

export const ROLL_CHANCE_TOOL = "roll_chance";

export const RANDOMNESS_TOOL_NAMES = [ROLL_CHANCE_TOOL];

const ROLL_CHANCE_DESCRIPTION =
  "Roll for a chance that is expressed as a percentage, and get back whether it hit this time. " +
  "Call this whenever something you were told to do is conditional on a probability — " +
  "'from time to time', 'sometimes', 'in 30% of cases', 'with a 70% chance', 'rarely', " +
  "'about half the time'. Translate the wording into a percentage and pass it; the roll is a " +
  "real uniform random draw made outside you, which is the only way the stated rate actually " +
  "happens. Never decide such a thing yourself and never guess the outcome: you cannot sample " +
  "randomly, and a made-up answer will not match the requested frequency. Call it once per " +
  "decision, and act on the verdict you get back — HIT means do the thing this time, MISS means " +
  "do not.";

const rollChanceOutputSchema = {
  hit: z.boolean().describe("True when the roll came in under the percentage"),
  percent: z.number().describe("The percentage that was rolled against"),
  roll: z.number().describe("The number rolled, on the same 0-100 scale"),
};

/**
 * A uniform draw from [0, 100), in hundredths of a percent.
 *
 * `randomInt` over a fixed number of steps rather than `Math.random() * 100`:
 * it is drawn from a CSPRNG with rejection sampling, so the distribution has no
 * modulo bias, and the step count is explicit instead of being whatever the
 * engine's float happens to give. The largest draw is 99.99, so a roll can never
 * print as 100 — see {@link ROLL_STEPS}.
 */
function roll(): number {
  return randomInt(0, ROLL_STEPS) / (ROLL_STEPS / MAX_PERCENT);
}

/** Register the randomness MCP tools on the shared server. */
export function registerRandomnessMcpTools(server: McpServer): void {
  server.registerTool(
    ROLL_CHANCE_TOOL,
    {
      title: "Roll for a percentage chance",
      description: ROLL_CHANCE_DESCRIPTION,
      inputSchema: {
        percent: z
          .number()
          .min(MIN_PERCENT)
          .max(MAX_PERCENT)
          .describe(
            "The chance of a hit, 0-100. Convert the wording you were given: 'half the time' " +
              "is 50, 'in 30% of cases' is 30, 'rarely' is a small number like 10. 0 never " +
              "hits and 100 always does.",
          ),
      },
      outputSchema: rollChanceOutputSchema,
      annotations: {
        // It changes nothing and touches nothing outside itself, but it is NOT
        // idempotent: the whole point is that two identical calls disagree.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ percent }) => {
      const outcome = chanceOutcome(percent, roll());
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        structuredContent: { hit: outcome.hit, percent: outcome.percent, roll: outcome.roll },
      };
    },
  );
}
