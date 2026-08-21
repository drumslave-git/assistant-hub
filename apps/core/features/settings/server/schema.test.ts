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

  it("allows an empty bot token string (clears) and null", () => {
    expect(updateSettingsSchema.parse({ telegramBotToken: "" })).toEqual({ telegramBotToken: "" });
    expect(updateSettingsSchema.parse({ telegramBotToken: null })).toEqual({
      telegramBotToken: null,
    });
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
