import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { sessionCookie } from "./session";
import {
  changeOperatorPassword,
  isAuthConfigured,
  judgeSessionToken,
  loginOperator,
  requireOperator,
  setupOperator,
} from "./service";

/**
 * The operator-auth flow against a real database: first-run setup, login,
 * session judgement, and the API gate — including the trace record every
 * attempt leaves behind.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "test" } as const;

const request = (cookie?: string): Request =>
  new Request("http://localhost/api/x", { headers: cookie ? { cookie } : {} });

describe("operator auth", () => {
  it("walks the first-run path: unconfigured → setup → valid session", async () => {
    expect(await isAuthConfigured(ctx.db)).toBe(false);
    expect(await judgeSessionToken(null, ctx.db)).toBe("unconfigured");

    const { token } = await setupOperator("hunter2hunter2", trigger, ctx.db);
    expect(await isAuthConfigured(ctx.db)).toBe(true);
    expect(await judgeSessionToken(token, ctx.db)).toBe("ok");
    expect(await judgeSessionToken("forged.token.sig", ctx.db)).toBe("invalid");
  });

  it("refuses a second setup — the password cannot be overwritten unauthenticated", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);
    await expect(setupOperator("attacker-pass-123", trigger, ctx.db)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects a too-short setup password", async () => {
    await expect(setupOperator("short", trigger, ctx.db)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("logs in with the right password, rejects the wrong one, and traces both", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);

    const { token } = await loginOperator("hunter2hunter2", trigger, ctx.db);
    expect(await judgeSessionToken(token, ctx.db)).toBe("ok");

    await expect(loginOperator("wrong-password", trigger, ctx.db)).rejects.toMatchObject({
      code: "unauthorized",
    });

    const traces = await listTraces({ feature: "auth" });
    const byAction = traces.traces.map((t) => `${t.action}:${t.status}`).sort();
    expect(byAction).toEqual(["login:error", "login:success", "setup:success"]);
    // The password itself must never be recorded anywhere in a trace.
    expect(JSON.stringify(traces)).not.toContain("hunter2hunter2");
  });

  it("gates a request by its session cookie", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);
    const { token } = await loginOperator("hunter2hunter2", trigger, ctx.db);

    await expect(
      requireOperator(request(sessionCookie(token).split(";")[0]), ctx.db),
    ).resolves.toBeUndefined();
    await expect(requireOperator(request(), ctx.db)).rejects.toBeInstanceOf(ApiError);
    await expect(requireOperator(request("op_session=forged.x.y"), ctx.db)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("stays open before setup so a fresh install can reach the dashboard API", async () => {
    await expect(requireOperator(request(), ctx.db)).resolves.toBeUndefined();
  });
});

describe("password change", () => {
  it("changes the password, signs out other sessions, keeps the caller in, and traces cleanly", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);
    const { token: otherSession } = await loginOperator("hunter2hunter2", trigger, ctx.db);

    const { token: fresh } = await changeOperatorPassword(
      "hunter2hunter2",
      "brand-new-pass",
      trigger,
      ctx.db,
    );

    // The secret rotation invalidates every pre-change session; only the fresh
    // token minted by the change itself still works.
    expect(await judgeSessionToken(otherSession, ctx.db)).toBe("invalid");
    expect(await judgeSessionToken(fresh, ctx.db)).toBe("ok");

    // Old password is dead, new one logs in.
    await expect(loginOperator("hunter2hunter2", trigger, ctx.db)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const { token } = await loginOperator("brand-new-pass", trigger, ctx.db);
    expect(await judgeSessionToken(token, ctx.db)).toBe("ok");

    const traces = await listTraces({ feature: "auth" });
    const byAction = traces.traces.map((t) => `${t.action}:${t.status}`).sort();
    expect(byAction).toContain("change-password:success");
    // Neither the old nor the new password may appear anywhere in a trace.
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("hunter2hunter2");
    expect(serialized).not.toContain("brand-new-pass");
  });

  it("rejects a wrong current password and traces the attempt", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);
    await expect(
      changeOperatorPassword("wrong-password", "brand-new-pass", trigger, ctx.db),
    ).rejects.toMatchObject({ code: "unauthorized" });

    // A failed attempt must not invalidate existing sessions.
    const { token } = await loginOperator("hunter2hunter2", trigger, ctx.db);
    expect(await judgeSessionToken(token, ctx.db)).toBe("ok");

    const traces = await listTraces({ feature: "auth" });
    expect(traces.traces.map((t) => `${t.action}:${t.status}`)).toContain("change-password:error");
  });

  it("rejects a too-short new password without checking the current one", async () => {
    await setupOperator("hunter2hunter2", trigger, ctx.db);
    await expect(
      changeOperatorPassword("hunter2hunter2", "short", trigger, ctx.db),
    ).rejects.toMatchObject({ code: "bad_request" });
    // Unchanged: the old password still logs in.
    await expect(loginOperator("hunter2hunter2", trigger, ctx.db)).resolves.toBeTruthy();
  });

  it("refuses before first-run setup", async () => {
    await expect(
      changeOperatorPassword("whatever-pass", "brand-new-pass", trigger, ctx.db),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
