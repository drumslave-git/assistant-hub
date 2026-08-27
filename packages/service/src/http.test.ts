import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { internalTokenGuard } from "./http";

/**
 * The guard every source app puts in front of its `/internal/*` surface. It
 * is the only thing standing between that surface and anything else that can
 * reach the service, so "no token" and "wrong token" are pinned here rather
 * than trusted to each app's own copy.
 */
describe("internalTokenGuard", () => {
  const app = new Hono();
  app.use("*", internalTokenGuard("the-secret"));
  app.get("/thing", (c) => c.json({ ok: true }));

  it("passes a request carrying the expected token", async () => {
    const res = await app.request("/thing", { headers: { "x-internal-token": "the-secret" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a missing token", async () => {
    const res = await app.request("/thing");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "unauthorized" } });
  });

  it("refuses a wrong token", async () => {
    const res = await app.request("/thing", { headers: { "x-internal-token": "guessed" } });
    expect(res.status).toBe(401);
  });
});
