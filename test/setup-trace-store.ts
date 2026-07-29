import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach } from "vitest";

import { __setDataDirsForTests } from "@/server/paths";
import { __resetTraceStoreForTests } from "@/server/trace/store";

/**
 * Global integration-test setup for the file-backed trace store.
 *
 * Traces used to live in Postgres and were isolated between tests by the shared
 * `ctx.truncate()`. They now live in an in-process store that appends to monthly
 * NDJSON logs under `data/traces`. This setup:
 *
 *  - points the trace directory at a throwaway temp dir per test file, so a suite never
 *    reads or writes the real dev trace logs, and
 *  - clears the in-memory store before every test, so trace-count assertions stay
 *    isolated the way the DB truncate used to guarantee.
 *
 * Registered via `setupFiles` in `vitest.integration.config.ts`, so every
 * integration suite gets this for free — no per-file wiring.
 */
const dir = mkdtempSync(path.join(tmpdir(), "traces-it-"));
__setDataDirsForTests({ traces: dir });
__resetTraceStoreForTests();

beforeEach(() => {
  __resetTraceStoreForTests();
});

afterAll(() => {
  __resetTraceStoreForTests();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
});
