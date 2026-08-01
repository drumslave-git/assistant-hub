import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setDataDirsForTests } from "@/server/paths";

import { ytDlpAssetName } from "../ytdlp-release";
import {
  currentTarget,
  getYtDlpInstallation,
  managedYtDlpPath,
  resolveYtDlpCommand,
  updateYtDlp,
} from "./ytdlp-binary";

/**
 * The self-updating yt-dlp binary, proved against a **stub** GitHub (a replaced
 * `fetch`) and stub binaries on disk: which copy the downloader runs, when a
 * check downloads anything, and — the part that matters — what happens when the
 * thing it downloads is wrong. A corrupt or incompatible binary must never
 * replace a working one, so those two cases are asserted on the file system, not
 * just on the return value.
 *
 * Nothing here touches the network or a real yt-dlp; `../ytdlp-release.test.ts`
 * covers the pure half of the contract.
 */

/** A stand-in yt-dlp: prints a version, like the real one's `--version`. */
function fakeBinary(version: string): string {
  return `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`;
}

/** A binary that exists and is executable but refuses to run — a wrong-libc build. */
const BROKEN_BINARY = `#!${process.execPath}\nprocess.exit(1);\n`;

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/";
/** The asset this machine's platform actually asks for. */
const ASSET = ytDlpAssetName(currentTarget()) ?? "yt-dlp_linux";

let dataBin: string;
let pathBin: string;
let originalPath: string | undefined;
/** Every URL the code under test fetched, in order. */
let fetched: string[];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Stand in for GitHub: one release document, one checksum listing, one asset.
 * `assetBody` is served verbatim, and `checksum` defaults to its real hash so a
 * mismatch has to be asked for explicitly.
 */
function stubGithub(options: {
  version: string;
  assetBody: string;
  checksum?: string;
  withAsset?: boolean;
}): void {
  const url = `${RELEASE_BASE}${options.version}/${ASSET}`;
  const sumsUrl = `${RELEASE_BASE}${options.version}/SHA2-256SUMS`;
  const assets = [{ name: "SHA2-256SUMS", browser_download_url: sumsUrl }];
  if (options.withAsset !== false) {
    assets.push({ name: ASSET, browser_download_url: url });
  }

  vi.stubGlobal("fetch", async (input: string | URL) => {
    const requested = String(input);
    fetched.push(requested);
    if (requested.endsWith("/releases/latest")) {
      return Response.json({ tag_name: options.version, assets });
    }
    if (requested === sumsUrl) {
      const hash = options.checksum ?? sha256(options.assetBody);
      return new Response(`${hash}  ${ASSET}\n`);
    }
    if (requested === url) return new Response(options.assetBody);
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  dataBin = mkdtempSync(path.join(tmpdir(), "ytdlp-data-"));
  pathBin = mkdtempSync(path.join(tmpdir(), "ytdlp-path-"));
  fetched = [];
  __setDataDirsForTests({ bin: dataBin });
  // An empty PATH is the "no yt-dlp anywhere" baseline; a case that wants a
  // system copy writes one into `pathBin`.
  originalPath = process.env.PATH;
  process.env.PATH = pathBin;
});

afterEach(() => {
  process.env.PATH = originalPath;
  __setDataDirsForTests(null);
  vi.unstubAllGlobals();
  rmSync(dataBin, { recursive: true, force: true });
  rmSync(pathBin, { recursive: true, force: true });
});

/** Put a stub yt-dlp on PATH, as the Docker image's pinned build would be. */
function installOnPath(contents: string): void {
  const file = path.join(pathBin, "yt-dlp");
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

/** Put a stub yt-dlp in the managed directory, as a previous update would have. */
function installManaged(contents: string): void {
  writeFileSync(managedYtDlpPath(), contents);
  chmodSync(managedYtDlpPath(), 0o755);
}

describe("resolveYtDlpCommand", () => {
  it("prefers the managed copy — it is the one the updater keeps current", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    installManaged(fakeBinary("2026.07.04"));

    expect(await resolveYtDlpCommand()).toBe(managedYtDlpPath());
  });

  it("falls back to PATH when no update has been installed", async () => {
    installOnPath(fakeBinary("2026.03.17"));

    expect(await resolveYtDlpCommand()).toBe("yt-dlp");
  });
});

describe("getYtDlpInstallation", () => {
  it("reports the managed copy and its version", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    installManaged(fakeBinary("2026.07.04"));

    expect(await getYtDlpInstallation()).toEqual({
      command: managedYtDlpPath(),
      source: "managed",
      version: "2026.07.04",
    });
  });

  it("falls through to the system copy", async () => {
    installOnPath(fakeBinary("2026.03.17"));

    expect(await getYtDlpInstallation()).toMatchObject({
      source: "system",
      version: "2026.03.17",
    });
  });

  it("reports `missing` rather than throwing when there is no yt-dlp at all", async () => {
    expect(await getYtDlpInstallation()).toEqual({
      command: "yt-dlp",
      source: "missing",
      version: null,
    });
  });

  it("ignores a managed copy that will not run", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    installManaged(BROKEN_BINARY);

    expect(await getYtDlpInstallation()).toMatchObject({ source: "system" });
  });
});

describe("updateYtDlp", () => {
  it("installs the upstream build when the machine has no yt-dlp", async () => {
    stubGithub({ version: "2026.07.04", assetBody: fakeBinary("2026.07.04") });

    const result = await updateYtDlp();

    expect(result).toMatchObject({
      updated: true,
      previousVersion: null,
      latestVersion: "2026.07.04",
    });
    expect(result.summary).toContain("2026.07.04");
    expect(await resolveYtDlpCommand()).toBe(managedYtDlpPath());
  });

  it("replaces an older build and reports both versions", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    stubGithub({ version: "2026.07.04", assetBody: fakeBinary("2026.07.04") });

    const result = await updateYtDlp();

    expect(result.updated).toBe(true);
    expect(result.summary).toBe("updated 2026.03.17 → 2026.07.04");
    expect(readFileSync(managedYtDlpPath(), "utf8")).toBe(fakeBinary("2026.07.04"));
  });

  it("downloads nothing when the installed build is already current", async () => {
    installOnPath(fakeBinary("2026.07.04"));
    stubGithub({ version: "2026.07.04", assetBody: fakeBinary("2026.07.04") });

    const result = await updateYtDlp();

    expect(result).toMatchObject({ updated: false, summary: "already current (2026.07.04)" });
    expect(fetched).toHaveLength(1); // the release check, and nothing more
  });

  it("refuses a download whose checksum does not match the release", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    stubGithub({
      version: "2026.07.04",
      assetBody: fakeBinary("2026.07.04"),
      checksum: "0".repeat(64),
    });

    await expect(updateYtDlp()).rejects.toThrow(/checksum mismatch/i);
    // The working binary is untouched and no partial file is left behind.
    expect(existsSync(managedYtDlpPath())).toBe(false);
    expect(readdirSync(dataBin)).toEqual([]);
  });

  it("keeps the previous binary when the downloaded one will not run", async () => {
    // The realistic case: the musl build landing on a glibc machine.
    installManaged(fakeBinary("2026.03.17"));
    stubGithub({ version: "2026.07.04", assetBody: BROKEN_BINARY });

    await expect(updateYtDlp()).rejects.toThrow(/does not run on this machine/i);
    expect(readFileSync(managedYtDlpPath(), "utf8")).toBe(fakeBinary("2026.03.17"));
    expect(readdirSync(dataBin)).toEqual(["yt-dlp"]);
  });

  it("treats GitHub being unreachable as a no-op, not a failure", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    vi.stubGlobal("fetch", async () => {
      throw new Error("ENOTFOUND api.github.com");
    });

    const result = await updateYtDlp();

    expect(result).toMatchObject({ updated: false, previousVersion: "2026.03.17" });
    expect(result.summary).toContain("could not reach GitHub");
  });

  it("treats a rate-limit body as no update information", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    vi.stubGlobal("fetch", async () => Response.json({ message: "API rate limit exceeded" }));

    const result = await updateYtDlp();

    expect(result.updated).toBe(false);
    expect(result.summary).toContain("no release information");
  });

  it("keeps the installed build when the release publishes no usable asset", async () => {
    installOnPath(fakeBinary("2026.03.17"));
    stubGithub({ version: "2026.07.04", assetBody: fakeBinary("2026.07.04"), withAsset: false });

    const result = await updateYtDlp();

    expect(result.updated).toBe(false);
    expect(result.summary).toContain("no usable");
  });

  it("reports each step so the job card can show progress", async () => {
    stubGithub({ version: "2026.07.04", assetBody: fakeBinary("2026.07.04") });
    const steps: string[] = [];

    await updateYtDlp({ onStep: (step) => steps.push(step) });

    expect(steps).toEqual([
      "Reading installed version",
      "Checking for a newer release",
      "Downloading yt-dlp 2026.07.04",
      "Verifying the downloaded binary",
    ]);
  });
});
