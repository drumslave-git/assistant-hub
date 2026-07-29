import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __setDataDirsForTests } from "@/server/paths";

import { getDownloadStorageHealth } from "./download";

/**
 * The download write-path probe. The real downloads directory is fixed at
 * `data/downloads`, so each case redirects it to a throwaway path through the
 * test-only override rather than re-importing the module.
 */

let dir: string;

function loadProbe(downloads: string): typeof getDownloadStorageHealth {
  __setDataDirsForTests({ downloads });
  return getDownloadStorageHealth;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dl-probe-"));
});

afterEach(() => {
  __setDataDirsForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("getDownloadStorageHealth", () => {
  it("reports the directory when the write path works", async () => {
    const getDownloadStorageHealth = loadProbe(dir);

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(true);
    expect(health.detail).toBe(path.resolve(dir));
  });

  it("creates the directory when it does not exist yet", async () => {
    const nested = path.join(dir, "not", "created", "yet");
    const getDownloadStorageHealth = loadProbe(nested);

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(true);
    expect(readdirSync(nested)).toEqual([]);
  });

  it("leaves no probe file behind", async () => {
    const getDownloadStorageHealth = loadProbe(dir);

    await getDownloadStorageHealth();
    await getDownloadStorageHealth();

    // A stray dotfile in a directory the operator browses would be a defect in its
    // own right, and a persistent probe file would mask a later permission change.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails with the real filesystem error when the path is unusable", async () => {
    // A file where a parent directory is expected: `mkdir -p` fails with ENOTDIR on
    // POSIX and Windows alike, unlike chmod which is largely a no-op on Windows.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const getDownloadStorageHealth = loadProbe(path.join(blocker, "downloads"));

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(false);
    // The message is the OS's, not ours — that is the point of a real probe.
    expect(health.detail).not.toBe("");
    expect(health.detail).toMatch(/ENOTDIR|EEXIST|ENOENT/);
  });
});
