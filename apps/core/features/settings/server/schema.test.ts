import { describe, expect, it } from "vitest";

import { testRoleConnectionSchema, updateSettingsSchema } from "./schema";

describe("updateSettingsSchema", () => {
  it("accepts a partial update", () => {
    expect(updateSettingsSchema.parse({ model: "gpt-4o-mini" })).toEqual({
      model: "gpt-4o-mini",
    });
  });

  it("rejects an empty update", () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("allows null backend ids (inherit chat) and rejects empty strings", () => {
    expect(updateSettingsSchema.parse({ chatBackendId: null })).toEqual({ chatBackendId: null });
    expect(updateSettingsSchema.parse({ visionBackendId: "some-id" })).toEqual({
      visionBackendId: "some-id",
    });
    expect(updateSettingsSchema.safeParse({ embeddingBackendId: "" }).success).toBe(false);
  });

  it("allows clearing role models with null and rejects empty model strings", () => {
    expect(updateSettingsSchema.parse({ audioModel: null })).toEqual({ audioModel: null });
    expect(updateSettingsSchema.safeParse({ browserModel: "" }).success).toBe(false);
  });

  it("does not take a bot token — connections are per assistant since Phase 3", () => {
    // An unknown key alone is an empty (rejected) update; zod strips it.
    expect(updateSettingsSchema.safeParse({ telegramBotToken: "12345:x" }).success).toBe(false);
  });
});

describe("testRoleConnectionSchema", () => {
  it("accepts any subset — omitted fields fall back to stored values", () => {
    expect(testRoleConnectionSchema.parse({})).toEqual({});
    expect(testRoleConnectionSchema.parse({ backendId: null, model: "bge-m3" })).toEqual({
      backendId: null,
      model: "bge-m3",
    });
    expect(testRoleConnectionSchema.safeParse({ model: "" }).success).toBe(false);
  });
});
