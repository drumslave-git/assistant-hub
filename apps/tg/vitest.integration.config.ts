import { defineConfig } from "vitest/config";

/**
 * Integration test config: real Postgres via Testcontainers (Docker
 * required). Mirrors apps/core's — generous timeouts for container startup,
 * serial files to bound resource use.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    exclude: ["node_modules", "dist", "**/.claude/worktrees/**"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
