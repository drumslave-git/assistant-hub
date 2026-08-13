import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Integration test config. Runs only `*.integration.test.ts` files, which spin
 * up real Postgres containers via Testcontainers (Docker required). Timeouts are
 * generous to cover container startup; files run serially to bound resource use.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    // `.claude/worktrees` for the reason given in `vitest.config.ts`: a
    // worktree is a full checkout inside the repo, so its copy of every
    // integration file would run again — here at Testcontainers prices — and
    // fail against whatever revision that worktree happens to hold.
    exclude: ["node_modules", ".next", "dist", "**/.claude/worktrees/**"],
    // Isolate the file-backed trace store (temp directory + per-test reset) so
    // trace assertions stay isolated now that traces live off the database.
    setupFiles: ["./test/setup-trace-store.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/empty.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
