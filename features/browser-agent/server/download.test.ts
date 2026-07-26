import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The download write-path probe. `DOWNLOADS_DIR` is resolved once at module load,
 * so each case points the env at a fresh path and re-imports the module.
 */

let dir: string;

async function loadProbe(downloadsDir: string) {
  process.env.DOWNLOADS_DIR = downloadsDir;
  vi.resetModules();
  const mod = await import("./download");
  return mod.getDownloadStorageHealth;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dl-probe-"));
});

afterEach(() => {
  delete process.env.DOWNLOADS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("getDownloadStorageHealth", () => {
  it("reports the directory when the write path works", async () => {
    const getDownloadStorageHealth = await loadProbe(dir);

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(true);
    expect(health.detail).toBe(path.resolve(dir));
  });

  it("creates the directory when it does not exist yet", async () => {
    const nested = path.join(dir, "not", "created", "yet");
    const getDownloadStorageHealth = await loadProbe(nested);

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(true);
    expect(readdirSync(nested)).toEqual([]);
  });

  it("leaves no probe file behind", async () => {
    const getDownloadStorageHealth = await loadProbe(dir);

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
    const getDownloadStorageHealth = await loadProbe(path.join(blocker, "downloads"));

    const health = await getDownloadStorageHealth();

    expect(health.ok).toBe(false);
    // The message is the OS's, not ours — that is the point of a real probe.
    expect(health.detail).not.toBe("");
    expect(health.detail).toMatch(/ENOTDIR|EEXIST|ENOENT/);
  });
});
