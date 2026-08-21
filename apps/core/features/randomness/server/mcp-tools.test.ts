import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerRandomnessMcpTools, ROLL_CHANCE_TOOL } from "./mcp-tools";

/**
 * The registered tool. The arithmetic is covered in `../chance.test.ts`; what
 * matters here is that the handler actually draws — a tool that always answered
 * the same thing would pass every assertion about its wording while quietly
 * destroying the one property it exists for.
 */

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent: { hit: boolean; percent: number; roll: number };
}

type Registered = { config: { description?: string }; handler: (args: { percent: number }) => Promise<ToolResult> };

function registered(): Record<string, Registered> {
  const out: Record<string, Registered> = {};
  const server = {
    registerTool: (name: string, config: unknown, handler: unknown) => {
      out[name] = { config, handler } as Registered;
    },
  } as unknown as McpServer;
  registerRandomnessMcpTools(server);
  return out;
}

const handler = () => registered()[ROLL_CHANCE_TOOL].handler;

describe("roll_chance", () => {
  it("always hits at 100 and never at 0", async () => {
    const call = handler();
    for (let i = 0; i < 200; i++) {
      expect((await call({ percent: 100 })).structuredContent.hit).toBe(true);
      expect((await call({ percent: 0 })).structuredContent.hit).toBe(false);
    }
  });

  it("actually draws — repeated calls at 50% disagree", async () => {
    const call = handler();
    const results = new Set<boolean>();
    for (let i = 0; i < 200; i++) {
      results.add((await call({ percent: 50 })).structuredContent.hit);
    }
    // A stuck or constant source would give one value; 200 fair coins give both
    // with probability 1 - 2^-199.
    expect([...results].sort()).toEqual([false, true]);
  });

  it("lands near the requested rate", async () => {
    const call = handler();
    let hits = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      if ((await call({ percent: 30 })).structuredContent.hit) hits += 1;
    }
    // Generous bounds: this asserts "roughly 30%, not 50% and not 5%", which is
    // what a biased or inverted comparison would break. The binomial sd here is
    // ~0.7pp, so ±5pp is ~7 sd — it will not flake.
    expect(hits / runs).toBeGreaterThan(0.25);
    expect(hits / runs).toBeLessThan(0.35);
  });

  it("stays inside the 0-100 scale it reports", async () => {
    const call = handler();
    for (let i = 0; i < 500; i++) {
      const { roll } = (await call({ percent: 50 })).structuredContent;
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(100);
    }
  });

  it("returns the verdict as its text, with the numbers behind it", async () => {
    const result = await handler()({ percent: 100 });
    expect(result.content[0].text).toMatch(/^HIT \(rolled [\d.]+ < 100\)$/);
    expect(result.structuredContent.percent).toBe(100);
  });

  it("tells the model not to decide the outcome itself", async () => {
    // The failure mode this tool exists for is a model that answers the
    // probability question from its own head, so the description has to say so.
    const description = registered()[ROLL_CHANCE_TOOL].config.description ?? "";
    expect(description).toMatch(/never (decide|guess)/i);
    expect(description).toMatch(/%|percent/i);
  });
});
