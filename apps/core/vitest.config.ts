import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Test runner config. Mirrors the `@/*` path alias from tsconfig and stubs the
 * `server-only` import guard (which throws outside an RSC bundle) so server
 * modules can be unit-tested directly.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [
      "node_modules",
      ".next",
      "dist",
      // Agent worktrees are full checkouts *inside* the repo, so every test
      // file appears twice: once here and once in each worktree. That is not
      // just wasted time — a worktree holds a different revision, so its copy
      // fails against this one's code and reports a failure in a file the
      // working tree does not contain.
      "**/.claude/worktrees/**",
      // Integration tests (real Postgres via Testcontainers) run via
      // `npm run test:integration` with their own config.
      "**/*.integration.test.ts",
    ],
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/empty.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
