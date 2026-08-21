import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEnv, requireEnv, resetEnvCache } from "@/server/env";

const MANAGED = ["DATABASE_URL", "DATABASE_URL_FILE", "TZ", "NODE_ENV"] as const;

// Next.js types NODE_ENV as read-only on ProcessEnv; tests mutate it through
// this plain-record view.
const env = process.env as Record<string, string | undefined>;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of MANAGED) {
    saved[key] = env[key];
    delete env[key];
  }
  resetEnvCache();
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
  resetEnvCache();
});

describe("getEnv", () => {
  it("reads direct env values", () => {
    process.env.DATABASE_URL = "postgres://host/db";
    expect(getEnv().DATABASE_URL).toBe("postgres://host/db");
  });

  it("resolves the <NAME>_FILE Docker-secret variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-test-"));
    const file = join(dir, "database_url");
    writeFileSync(file, "  postgres://secret/db\n");
    process.env.DATABASE_URL_FILE = file;

    expect(getEnv().DATABASE_URL).toBe("postgres://secret/db");
  });

  it("rejects invalid enum values", () => {
    env.NODE_ENV = "staging";
    expect(() => getEnv()).toThrow(/environment configuration/i);
  });
});

describe("requireEnv", () => {
  it("returns the value when present", () => {
    process.env.DATABASE_URL = "postgres://x";
    expect(requireEnv("DATABASE_URL")).toBe("postgres://x");
  });

  it("throws service_unavailable when missing", () => {
    expect(() => requireEnv("DATABASE_URL")).toThrowError(
      expect.objectContaining({ code: "service_unavailable" }),
    );
  });
});
