import { describe, expect, it } from "vitest";

import { ApiError, isApiError, statusForCode } from "@/lib/api-error";

describe("ApiError", () => {
  it("maps codes to the expected HTTP status", () => {
    expect(ApiError.badRequest().status).toBe(400);
    expect(ApiError.notFound().status).toBe(404);
    expect(ApiError.unauthorized().status).toBe(401);
    expect(ApiError.conflict().status).toBe(409);
    expect(ApiError.serviceUnavailable().status).toBe(503);
    expect(ApiError.internal().status).toBe(500);
    expect(statusForCode("validation_error")).toBe(422);
  });

  it("builds a client-safe body with optional details", () => {
    const err = new ApiError("validation_error", "nope", { details: { field: "x" } });
    expect(err.toBody()).toEqual({
      error: { code: "validation_error", message: "nope", details: { field: "x" } },
    });
  });

  it("omits details when not provided", () => {
    const body = ApiError.notFound("gone").toBody();
    expect(body.error).toEqual({ code: "not_found", message: "gone" });
    expect("details" in body.error).toBe(false);
  });

  it("preserves cause without exposing it in the body", () => {
    const cause = new Error("db down");
    const err = ApiError.internal("boom", { cause });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err.toBody())).not.toContain("db down");
  });

  it("is recognized by isApiError", () => {
    expect(isApiError(ApiError.badRequest())).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
  });
});
