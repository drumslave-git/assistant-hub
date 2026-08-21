import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";
import {
  clearedSessionCookie,
  mintSessionToken,
  readSessionCookie,
  sessionCookie,
  verifySessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./session";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(stored).not.toContain("correct horse battery");
    expect(verifyPassword("correct horse battery", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts: the same password hashes differently each time", () => {
    expect(hashPassword("p@ssword123")).not.toBe(hashPassword("p@ssword123"));
  });

  it("rejects corrupt stored values instead of crashing", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt:bad:8:1:AA==:AA==")).toBe(false);
  });
});

describe("session tokens", () => {
  const secret = "test-secret";

  it("mints a token the same secret verifies", () => {
    const token = mintSessionToken(secret);
    expect(verifySessionToken(secret, token)).toBe(true);
  });

  it("rejects a token signed with a different secret (rotation logs everyone out)", () => {
    const token = mintSessionToken(secret);
    expect(verifySessionToken("rotated", token)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = mintSessionToken(secret);
    const [exp, nonce, sig] = token.split(".");
    expect(verifySessionToken(secret, `${Number(exp) + 9999}.${nonce}.${sig}`)).toBe(false);
  });

  it("rejects an expired token", () => {
    const past = new Date(Date.now() - SESSION_TTL_MS - 1000);
    const token = mintSessionToken(secret, past);
    expect(verifySessionToken(secret, token)).toBe(false);
  });

  it("round-trips through the cookie helpers", () => {
    const token = mintSessionToken(secret);
    const header = sessionCookie(token).split(";")[0];
    expect(readSessionCookie(`other=1; ${header}; x=2`)).toBe(token);
    expect(readSessionCookie(null)).toBeNull();
    expect(clearedSessionCookie()).toContain(`${SESSION_COOKIE}=;`);
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });
});
