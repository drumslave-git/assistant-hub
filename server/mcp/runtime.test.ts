import { describe, expect, it } from "vitest";

import { expectedToolNames, loadMcpRegistry } from "./runtime";

/**
 * The shared registry's cache identity.
 *
 * It lives on a `globalThis` symbol so it survives module re-evaluation across
 * Next bundles and dev hot reload — which is what makes it possible for a
 * running server to keep serving a tool list the source no longer matches. That
 * failure is silent and misleading in both directions: the bot is never offered
 * the new tool and answers in prose (promising to do the thing it has no tool
 * for), while `/tools` renders the same stale list and reads as a page nobody
 * updated. So the registry checks itself against the loaded code.
 */

const STORE_KEY = Symbol.for("llm-tg-bot.mcp.registry");

interface Store {
  registry: unknown;
  loading: unknown;
}

function store(): Store {
  return (globalThis as typeof globalThis & { [STORE_KEY]: Store })[STORE_KEY];
}

describe("loadMcpRegistry", () => {
  it("registers exactly the tools the registrar table declares", async () => {
    // Not a tautology: `expectedToolNames` is read *without* building, so a
    // registrar whose declared names drift from what it actually registers would
    // make the freshness check permanently false — rebuilding the whole MCP
    // server on every reply turn. This is what catches that.
    const registry = await loadMcpRegistry();
    expect([...registry.registeredToolNames].sort()).toEqual([...expectedToolNames()].sort());
  });

  it("reuses the cached registry when the tool set still matches", async () => {
    const first = await loadMcpRegistry();
    const second = await loadMcpRegistry();
    expect(second).toBe(first);
  });

  it("rebuilds when the cached registry's tools no longer match the code", async () => {
    const first = await loadMcpRegistry();
    // A registry built before a feature's registrar existed — the real case.
    store().registry = { registeredToolNames: ["history_search"] };

    const rebuilt = await loadMcpRegistry();

    expect(rebuilt).not.toBe(first);
    expect([...rebuilt.registeredToolNames].sort()).toEqual([...expectedToolNames()].sort());
  });

  it("rebuilds when the cached instance predates the class itself", async () => {
    // Observed while adding the check: after a hot reload the surviving object
    // had no `registeredToolNames` accessor at all, and reading it threw.
    store().registry = {};

    const rebuilt = await loadMcpRegistry();

    expect(Array.isArray(rebuilt.registeredToolNames)).toBe(true);
    expect(rebuilt.registeredToolNames).toContain("rules_create");
  });
});
