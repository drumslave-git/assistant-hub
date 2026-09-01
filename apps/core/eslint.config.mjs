import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Every import must be declared in THIS app's package.json. The root
      // workspace install links every package regardless, so an undeclared
      // workspace or npm dependency only fails inside the Docker image, whose
      // deps stage copies the declared manifests alone.
      "import/no-extraneous-dependencies": ["error", { includeTypes: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local runtime data, never source. `/data` holds the Compose bind mounts —
    // `PG_DATA_DIR` defaults to ./data/pg, which Postgres owns as root with mode
    // 0700, so walking it fails the whole lint run with EACCES. `/downloads` is
    // the browser agent's default DOWNLOADS_DIR. Both are already gitignored.
    "data/**",
    "downloads/**",
  ]),
]);

export default eslintConfig;
