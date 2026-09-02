import { describe, expect, it, vi } from "vitest";

import {
  getToolContext,
  runWithToolContext,
  toolContextTrigger,
  tryGetToolContext,
} from "./context";

/**
 * The per-turn tool context has to survive the one thing this app guarantees:
 * the same server module is evaluated more than once in a running process
 * (instrumentation vs. Route Handler bundles, plus every dev hot reload), while
 * the MCP registry that holds the tool handlers is a `globalThis` singleton that
 * outlives all of it. A storage that belongs to a module instance therefore
 * binds one copy and is read from another, and every tool fails with "no chat is
 * bound" while the pipeline is doing everything right.
 *
 * A second module instance is exactly what `vi.resetModules()` produces, so the
 * failure is reproducible here rather than only in production.
 */

describe("MCP tool context", () => {
  it("carries the bound chat into a second instance of this module", async () => {
    vi.resetModules();
    const reloaded = await import("./context");
    // Guard the guard: without a genuinely separate instance this asserts nothing.
    expect(reloaded.getToolContext).not.toBe(getToolContext);

    const seen = await runWithToolContext({ source: "tg", chatId: "chat-1", userId: "user-1" }, async () =>
      reloaded.getToolContext(),
    );

    expect(seen.chatId).toBe("chat-1");
    expect(seen.userId).toBe("user-1");
  });

  it("reports no context to a second instance outside a turn", async () => {
    vi.resetModules();
    const reloaded = await import("./context");

    expect(reloaded.tryGetToolContext()).toBeNull();
  });

  it("unbinds again once the turn is over", async () => {
    await runWithToolContext({ source: "tg", chatId: "chat-1" }, async () => undefined);

    expect(tryGetToolContext()).toBeNull();
    expect(() => getToolContext()).toThrow(/no chat is bound/);
  });
});

describe("toolContextTrigger", () => {
  it("stamps the turn's correlation so tool-driven traces join their turn's flow", () => {
    expect(
      toolContextTrigger({ source: "tg", chatId: "100", userId: "77", correlationId: "100:41" }),
    ).toEqual({ kind: "transport", actor: "77", correlationId: "100:41" });
  });

  it("falls back to the chat id when the context carries no correlation", () => {
    expect(toolContextTrigger({ source: "tg", chatId: "100" })).toEqual({
      kind: "transport",
      actor: "100",
      correlationId: "100",
    });
  });
});
