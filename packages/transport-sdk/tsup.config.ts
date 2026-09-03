import { defineConfig } from "tsup";

/**
 * The SDK ships **built** output, not the workspace sources.
 *
 * A transport is developed in its own repository, so nothing it installs may
 * resolve to a package that only exists in this one. The four internal
 * packages the SDK is assembled from (`contracts`, `bus`, `service`, `media`)
 * are private and unpublished, which is why they are `devDependencies` here
 * and `noExternal` below: their code is inlined into `dist/index.js` and their
 * types into `dist/index.d.ts`, and the published manifest has no dependency
 * an outsider cannot install.
 *
 * Everything else stays external and is declared in `package.json`. The four
 * libraries whose objects the author constructs and hands to the SDK — Hono,
 * the MCP SDK and zod (plus Hono's node adapter) — are peer dependencies, so
 * a transport and the SDK share exactly one copy: two `McpServer` classes or
 * two zod registries in one process is a class of bug worth designing out.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // `noExternal` inlines the JS; the declaration build is a SEPARATE pass that
  // does not read it, and left alone it emits `export { … } from
  // "@assistant-hub-swarm/contracts"` — a d.ts that resolves to nothing on any
  // machine but this one, so every type in the package would be `any` for the
  // author who installed it. `dts.resolve` makes that pass follow the same
  // packages and inline their declarations too.
  dts: { resolve: [/^@assistant-hub-swarm\//] },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node24",
  platform: "node",
  noExternal: [/^@assistant-hub-swarm\//],
});
