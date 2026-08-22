import { defineConfig } from "vitest/config";

/**
 * Integration test config: real Redis via Testcontainers (Docker required).
 * Mirrors the store suites — generous timeouts for container startup,
 * serial files.
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
