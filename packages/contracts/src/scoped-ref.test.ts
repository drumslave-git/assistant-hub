import { describe, expect, it } from "vitest";

import {
  formatScopedRef,
  isScopedRef,
  parseScopedRef,
  scopedRef,
  scopedRefSchema,
  tryParseScopedRef,
} from "./scoped-ref";

describe("scoped refs", () => {
  it("round-trips format -> parse", () => {
    const s = scopedRef("tg", "user", "12345");
    expect(s).toBe("tg:user:12345");
    expect(parseScopedRef(s)).toEqual({ source: "tg", kind: "user", id: "12345" });
  });

  it("keeps colons inside the id", () => {
    const parsed = parseScopedRef("chat:thread:a:b:c");
    expect(parsed.id).toBe("a:b:c");
    expect(formatScopedRef(parsed)).toBe("chat:thread:a:b:c");
  });

  it("accepts negative telegram chat ids", () => {
    expect(parseScopedRef("tg:chat:-1009876")).toEqual({
      source: "tg",
      kind: "chat",
      id: "-1009876",
    });
  });

  it("rejects unknown sources and kinds, missing parts, empty ids", () => {
    for (const bad of [
      "signal:user:1",
      "tg:project:1",
      "tg:user:",
      "tg:user",
      "tg",
      "",
      "user:tg:1",
    ]) {
      expect(tryParseScopedRef(bad), bad).toBeNull();
      expect(isScopedRef(bad), bad).toBe(false);
      expect(() => parseScopedRef(bad), bad).toThrow();
      expect(scopedRefSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("refuses to format an empty id", () => {
    expect(() => formatScopedRef({ source: "tg", kind: "user", id: "" })).toThrow();
  });

  it("validates through the zod schema", () => {
    expect(scopedRefSchema.parse("chat:user:uuid-1")).toBe("chat:user:uuid-1");
  });
});
