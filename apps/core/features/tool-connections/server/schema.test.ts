import { describe, expect, it } from "vitest";

import {
  createToolConnectionSchema,
  parsePrefixedToolName,
  prefixedToolName,
  updateToolConnectionSchema,
} from "./schema";

/**
 * The tool-connections contract's pure half: the slug rules (it becomes a
 * model-visible tool prefix, so it has to survive a round trip) and the
 * input validation the Route Handlers lean on.
 */

describe("prefixed tool names", () => {
  it("round-trips a prefixed name", () => {
    const prefixed = prefixedToolName("weather", "get_forecast");
    expect(prefixed).toBe("weather__get_forecast");
    expect(parsePrefixedToolName(prefixed)).toEqual({ slug: "weather", tool: "get_forecast" });
  });

  it("keeps the tool's own underscores", () => {
    expect(parsePrefixedToolName("weather__get__forecast")).toEqual({
      slug: "weather",
      tool: "get__forecast",
    });
  });

  it("rejects a bare built-in tool name", () => {
    // Built-ins keep bare names, so anything unprefixed must not resolve to a
    // connection — otherwise `memory_save` would look like slug `memory`.
    expect(parsePrefixedToolName("memory_save")).toBeNull();
    expect(parsePrefixedToolName("__orphan")).toBeNull();
    expect(parsePrefixedToolName("weather__")).toBeNull();
  });
});

describe("create input", () => {
  const base = { slug: "weather", name: "Weather", endpointUrl: "https://example.test/mcp" };

  it("defaults to an enabled, global, all-assistants http connection", () => {
    expect(createToolConnectionSchema.parse(base)).toEqual({
      ...base,
      transport: "http",
      authHeaders: {},
      enabled: true,
      appScope: null,
      allAssistants: true,
      assistantIds: [],
    });
  });

  it("normalizes the slug and rejects one that cannot be a tool prefix", () => {
    expect(createToolConnectionSchema.parse({ ...base, slug: " Weather " }).slug).toBe("weather");
    for (const slug of ["1weather", "wea ther", "weather_x", "-weather", ""]) {
      expect(createToolConnectionSchema.safeParse({ ...base, slug }).success).toBe(false);
    }
  });

  it("rejects a non-http endpoint and a malformed header name", () => {
    expect(
      createToolConnectionSchema.safeParse({ ...base, endpointUrl: "ftp://example.test" }).success,
    ).toBe(false);
    expect(
      createToolConnectionSchema.safeParse({ ...base, authHeaders: { "bad header": "v" } })
        .success,
    ).toBe(false);
  });
});

describe("update input", () => {
  it("requires at least one field", () => {
    expect(updateToolConnectionSchema.safeParse({}).success).toBe(false);
    expect(updateToolConnectionSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("accepts clearing the app scope", () => {
    expect(updateToolConnectionSchema.parse({ appScope: null })).toEqual({ appScope: null });
  });
});
