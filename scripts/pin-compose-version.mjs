#!/usr/bin/env node
/**
 * Keeps `docker-compose.yml`'s image pins on the version this repository is
 * actually releasing.
 *
 *   node scripts/pin-compose-version.mjs           # rewrite the pins
 *   node scripts/pin-compose-version.mjs --check   # fail if they are stale
 *
 * Compose is the operator's artifact: it is what someone clones and runs, so a
 * pin left behind by a release would silently start them on an old build —
 * exactly the kind of staleness nobody notices until it matters. The rewrite
 * runs as part of `npm run release:*`, and the check runs in the release
 * workflow's verify job, so a version can neither ship with a stale pin nor
 * have one hand-edited out of sync.
 *
 * Only the DEFAULT inside `${AHW_VERSION:-…}` is touched. An operator setting
 * `AHW_VERSION` still wins at runtime; this file has no opinion about that.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = join(ROOT, "docker-compose.yml");

/** `${AHW_VERSION:-1.2.3}` — the default is group 1. */
const PIN = /(\$\{AHW_VERSION:-)([^}]*)(\})/g;

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const before = readFileSync(COMPOSE, "utf8");

const stale = [...before.matchAll(PIN)].filter((m) => m[2] !== version);
const check = process.argv.includes("--check");

if (check) {
  if (stale.length === 0) {
    console.log(`docker-compose.yml pins ${version} — in sync.`);
    process.exit(0);
  }
  console.error(
    `docker-compose.yml pins ${stale.map((m) => m[2]).join(", ")} but this release is ` +
      `${version}.\nRun: node scripts/pin-compose-version.mjs`,
  );
  process.exit(1);
}

const after = before.replace(PIN, (_whole, open, _old, close) => `${open}${version}${close}`);
if (after === before) {
  console.log(`docker-compose.yml already pins ${version}.`);
} else {
  writeFileSync(COMPOSE, after);
  console.log(`docker-compose.yml pinned to ${version}.`);
}
