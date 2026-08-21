import { describe, expect, it } from "vitest";

import { traceQuerySchema } from "./schema";

describe("traceQuerySchema", () => {
  it("coerces numeric limit/offset from query strings", () => {
    expect(traceQuerySchema.parse({ limit: "20", offset: "40" })).toEqual({
      limit: 20,
      offset: 40,
    });
  });

  it("accepts an empty query", () => {
    expect(traceQuerySchema.parse({})).toEqual({});
  });

  it("passes through a valid feature and status", () => {
    expect(traceQuerySchema.parse({ feature: "settings", status: "error" })).toEqual({
      feature: "settings",
      status: "error",
    });
  });

  it("rejects an unknown status", () => {
    expect(traceQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
  });

  it("enforces the limit ceiling and non-negative offset", () => {
    expect(traceQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(traceQuerySchema.safeParse({ limit: "999" }).success).toBe(false);
    expect(traceQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});
