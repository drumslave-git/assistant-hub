import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson, parseQuery, toApiError } from "@/server/http";

// defineRoute checks the operator session (a DB read) on every non-public
// route; these unit tests exercise the wrapper's own machinery, so the check is
// stubbed and asserted separately below.
const requireOperatorMock = vi.fn<(request: Request) => Promise<void>>(async () => undefined);
vi.mock("@/server/auth/service", () => ({
  requireOperator: (request: Request) => requireOperatorMock(request),
}));

function jsonRequest(body: unknown, url = "http://test/api"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ok", () => {
  it("wraps data in the shared envelope", async () => {
    const res = ok({ id: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 1 } });
  });
});

describe("toApiError", () => {
  it("passes through ApiError", () => {
    const err = ApiError.notFound();
    expect(toApiError(err)).toBe(err);
  });

  it("maps ZodError to validation_error", () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const mapped = toApiError(parsed.error);
    expect(mapped.code).toBe("validation_error");
    expect(mapped.status).toBe(422);
  });

  it("maps unknown errors to internal_error without leaking the message", () => {
    const mapped = toApiError(new Error("secret detail"));
    expect(mapped.code).toBe("internal_error");
    expect(mapped.message).toBe("Internal server error");
  });
});

describe("parseJson", () => {
  it("validates a JSON body", async () => {
    const schema = z.object({ name: z.string() });
    await expect(parseJson(jsonRequest({ name: "a" }), schema)).resolves.toEqual({
      name: "a",
    });
  });

  it("rejects invalid JSON with bad_request", async () => {
    const req = new Request("http://test/api", { method: "POST", body: "{not json" });
    await expect(parseJson(req, z.unknown())).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("parseQuery", () => {
  it("parses and validates search params", () => {
    const req = new Request("http://test/api?limit=5");
    const schema = z.object({ limit: z.coerce.number() });
    expect(parseQuery(req, schema)).toEqual({ limit: 5 });
  });
});

describe("defineRoute", () => {
  it("returns the body's response on success", async () => {
    const handler = defineRoute(async ({ params }) => ok({ params }));
    const res = await handler(new Request("http://test/api"), {
      params: Promise.resolve({ id: "42" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { params: { id: "42" } } });
  });

  it("maps thrown ApiError to the shared error envelope", async () => {
    const handler = defineRoute(async () => {
      throw ApiError.notFound("missing");
    });
    const res = await handler(new Request("http://test/api"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "missing" },
    });
  });

  it("maps unexpected errors to 500 without leaking details", async () => {
    const handler = defineRoute(async () => {
      throw new Error("internal secret");
    });
    const res = await handler(new Request("http://test/api"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("internal secret");
  });

  it("answers 401 when the session check rejects, without running the body", async () => {
    requireOperatorMock.mockRejectedValueOnce(ApiError.unauthorized("Sign in"));
    const body = vi.fn(async () => ok({}));
    const res = await defineRoute(body)(new Request("http://test/api"));
    expect(res.status).toBe(401);
    expect(body).not.toHaveBeenCalled();
  });

  it("skips the session check only when a route opts out with auth: false", async () => {
    requireOperatorMock.mockClear();
    const open = defineRoute(async () => ok({ open: true }), { auth: false });
    expect((await open(new Request("http://test/api"))).status).toBe(200);
    expect(requireOperatorMock).not.toHaveBeenCalled();

    const gated = defineRoute(async () => ok({}));
    await gated(new Request("http://test/api"));
    expect(requireOperatorMock).toHaveBeenCalledOnce();
  });
});
