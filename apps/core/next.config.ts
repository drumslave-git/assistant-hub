import path from "node:path";

import type { NextConfig } from "next";

// Root manifest, not this app's: the monorepo releases on one version (the
// release pipeline watches the root "version" field), so build info reports it.
import pkg from "../../package.json";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (`.next/standalone`) so the
  // production image ships only traced runtime deps, not the full node_modules.
  output: "standalone",
  // Trace from the monorepo root so workspace packages and the root
  // node_modules land in the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Workspace packages ship TypeScript sources (just-in-time packages); Next
  // compiles them as part of this app's build.
  transpilePackages: [
    "@assistant-hub-swarm/contracts",
    "@assistant-hub-swarm/db",
    "@assistant-hub-swarm/tg-ui",
    "@assistant-hub-swarm/ui",
  ],
  // Inline only name/version for `lib/build-info` — importing package.json from
  // client-reachable code shipped the whole manifest (dependency list and
  // versions) into the browser bundle.
  env: {
    NEXT_PUBLIC_APP_NAME: pkg.name,
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Playwright is a native Node package (spawns a browser binary); never bundle
  // it — leave it as an external `require` resolved from node_modules at runtime.
  // Native Node packages that spawn binaries / load native addons must never be
  // bundled — leave them as runtime `require`s resolved from node_modules.
  serverExternalPackages: ["playwright", "sharp"],
};

export default nextConfig;
