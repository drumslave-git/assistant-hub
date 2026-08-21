import { describe, expect, it, vi } from "vitest";

import { runWebSearch } from "./search";

/** A fake `fetch` returning a JSON body with the given status. */
function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("runWebSearch", () => {
  it("returns an ok result with sources and context on success", async () => {
    const fetchFn = fakeFetch({
      answer: "Because reasons.",
      results: [{ title: "Why", url: "https://why", content: "Details." }],
    });

    const out = await runWebSearch("why is the sky blue", { apiKey: "tvly-key", fetch: fetchFn });

    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([{ title: "Why", url: "https://why" }]);
    expect(out.context).toContain("Because reasons.");
    expect(out.context).toContain("Source: https://why");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("passes the query and Bearer key to Tavily", async () => {
    const fetchFn = fakeFetch({ answer: null, results: [] });
    await runWebSearch("cats", { apiKey: "tvly-key", fetch: fetchFn });

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-key");
    expect(JSON.parse(init.body as string).query).toBe("cats");
  });

  it("fails (without throwing) on an empty query", async () => {
    const fetchFn = fakeFetch({});
    const out = await runWebSearch("   ", { apiKey: "tvly-key", fetch: fetchFn });

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/empty/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails gracefully on a non-OK HTTP response", async () => {
    const fetchFn = fakeFetch("rate limited", false, 429);
    const out = await runWebSearch("cats", { apiKey: "tvly-key", fetch: fetchFn });

    expect(out.ok).toBe(false);
    expect(out.context).toContain("failed");
    expect(out.reason).toContain("429");
  });

  it("fails gracefully when fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const out = await runWebSearch("cats", { apiKey: "tvly-key", fetch: fetchFn });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe("network down");
    expect(out.context).toContain("Do not pretend you searched successfully");
  });

  it("fails when no API key is configured", async () => {
    const fetchFn = fakeFetch({});
    const out = await runWebSearch("cats", { apiKey: "", fetch: fetchFn });

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not configured/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
