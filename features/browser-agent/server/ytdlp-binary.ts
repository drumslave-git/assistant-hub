import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { binDir } from "@/server/paths";

import {
  findAsset,
  isUpdateAvailable,
  parseChecksums,
  parseRelease,
  parseYtDlpVersion,
  ytDlpAssetName,
  YTDLP_CHECKSUM_ASSET,
  YTDLP_LATEST_RELEASE_URL,
  type PlatformTarget,
  type YtDlpRelease,
} from "../ytdlp-release";

/**
 * The yt-dlp binary the media downloader runs, and the machinery that keeps it
 * current.
 *
 * yt-dlp is the one dependency that cannot be pinned at build time and forgotten:
 * it tracks sites that change on purpose, and a build a few months old stops
 * extracting *everything* rather than degrading. The image pins a known-good
 * upstream build as the floor; this module keeps a newer one beside it under
 * `data/bin`, refreshed by the daily job in `ytdlp-scheduler.ts`.
 *
 * Resolution order, most to least current: the managed copy → whatever is on
 * `PATH` (the image's pinned build, or the operator's own install in local dev).
 * Nothing here is required for the app to work — a machine with no yt-dlp at all
 * behaves exactly as before, with `browser_download_media` reporting it is not
 * installed.
 *
 * Trust model: the release metadata, the binary, and its SHA-256 all come from
 * yt-dlp's own GitHub release. The hash is checked because a truncated or
 * corrupted download must never be executed; it is *not* a signature check —
 * GitHub's `SHA2-256SUMS.sig` needs the yt-dlp GPG key, and this deployment has
 * no keyring. So the guarantee is "exactly the file that release published",
 * with GitHub and the release itself trusted. The asset URL is checked against a
 * literal prefix so a surprising API response cannot redirect the download
 * elsewhere, and the downloaded binary must run successfully before it replaces
 * anything.
 */

/** Filename of the managed copy inside {@link binDir}. */
const BINARY_NAME = "yt-dlp";

/** Fallback command: whatever `PATH` resolves, which is what the image installs. */
const SYSTEM_COMMAND = "yt-dlp";

/** Ceiling on a downloaded binary — upstream's builds are ~40 MB. */
const MAX_BINARY_BYTES = 150 * 1024 * 1024;

const RELEASE_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 20_000;

/**
 * GitHub rejects an API request with no user agent, and an unauthenticated caller
 * is rate-limited per IP (60/hour) — far above one check a day.
 */
const REQUEST_HEADERS = { "user-agent": "llm-tg-bot-nextjs (yt-dlp updater)" };

/** Absolute path of the managed copy. */
export function managedYtDlpPath(): string {
  return path.join(binDir(), BINARY_NAME);
}

/** Where the yt-dlp being run came from. */
export type YtDlpSource = "managed" | "system" | "missing";

/** What yt-dlp this machine will actually run right now. */
export interface YtDlpInstallation {
  /** Command or path passed to `spawn`. */
  command: string;
  source: YtDlpSource;
  /** Version it reports, or null when it is absent or unreadable. */
  version: string | null;
}

/** This machine, for asset selection. Exported so tests can target another one. */
export function currentTarget(): PlatformTarget {
  return {
    platform: process.platform,
    arch: process.arch,
    // Node reports a glibc version only when it is linked against glibc; its
    // absence on Linux means musl (Alpine), which needs the other build.
    musl:
      process.platform === "linux" &&
      process.report?.getReport != null &&
      (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
        ?.glibcVersionRuntime == null,
  };
}

/**
 * The command the media downloader should spawn: the managed copy when one is
 * installed and executable, otherwise the `PATH` name.
 *
 * Resolved per download rather than cached, so an update that lands mid-uptime
 * takes effect on the next download instead of the next restart. It is two
 * `stat`-class syscalls against a local path — nothing worth caching.
 */
export async function resolveYtDlpCommand(): Promise<string> {
  const managed = managedYtDlpPath();
  try {
    await fs.access(managed, fs.constants.X_OK);
    return managed;
  } catch {
    return SYSTEM_COMMAND;
  }
}

/**
 * Run `--version` on a specific binary. Returns null when it is missing, not
 * executable, too slow, or prints something unrecognizable — every one of which
 * means "do not rely on this copy".
 */
async function readVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const proc = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(null);
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();

    let out = "";
    proc.stdout?.on("data", (chunk: unknown) => {
      out = `${out}${String(chunk)}`.slice(0, 500);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? parseYtDlpVersion(out) : null);
    });
  });
}

/**
 * What yt-dlp this machine runs and where it came from. Never throws — an absent
 * binary is a reportable state (`missing`), not an error, because the dashboard
 * card and the job summary both have to say so.
 */
export async function getYtDlpInstallation(): Promise<YtDlpInstallation> {
  const managed = managedYtDlpPath();
  const managedVersion = await readVersion(managed);
  if (managedVersion) return { command: managed, source: "managed", version: managedVersion };

  const systemVersion = await readVersion(SYSTEM_COMMAND);
  if (systemVersion) {
    return { command: SYSTEM_COMMAND, source: "system", version: systemVersion };
  }
  return { command: SYSTEM_COMMAND, source: "missing", version: null };
}

/** Outcome of one update check. */
export interface YtDlpUpdateResult {
  /** Whether a new binary was installed. */
  updated: boolean;
  /** Version in use before the check, or null when none was installed. */
  previousVersion: string | null;
  /** Newest version upstream published, or null when the check could not read it. */
  latestVersion: string | null;
  /** One-line outcome for the job card and the trace. */
  summary: string;
}

/** Fetch JSON from a fixed upstream URL, failing loudly on anything unexpected. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { ...REQUEST_HEADERS, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return response.json();
}

/** Fetch the checksum listing that accompanies a release. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return response.text();
}

/**
 * Stream a release asset to `destination`, returning its SHA-256. Hashing while
 * writing keeps a 40 MB binary out of memory and means the file is never read
 * twice.
 */
async function downloadAsset(url: string, destination: string): Promise<string> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("Download failed: empty response body");

  const hash = createHash("sha256");
  let written = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > MAX_BINARY_BYTES) {
        cb(new Error("Download failed: release asset is implausibly large"));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    createWriteStream(destination, { mode: 0o755 }),
  );
  return hash.digest("hex");
}

/** Progress callback shape shared with the scheduler (`IntervalRunContext`). */
export interface UpdateOptions {
  onStep?: (step: string) => void;
}

/**
 * Check upstream and install a newer yt-dlp when there is one.
 *
 * Returns rather than throws for every *expected* dead end — an unsupported
 * platform, an already-current binary, GitHub being unreachable — because none of
 * them is a failure the operator has to act on: the previous binary keeps
 * working and the next nightly run tries again. A checksum mismatch or a
 * downloaded binary that will not run does throw, since that is a real problem
 * worth a red card.
 *
 * Safe to interrupt: everything is written to a pid-scoped temporary file and
 * only moved over the live path once it has been hashed *and* executed
 * successfully, so a crash mid-update can never leave a half-written or
 * incompatible binary in place.
 */
export async function updateYtDlp(options: UpdateOptions = {}): Promise<YtDlpUpdateResult> {
  const step = options.onStep ?? (() => {});

  step("Reading installed version");
  const installed = await getYtDlpInstallation();
  const previousVersion = installed.version;

  const assetName = ytDlpAssetName(currentTarget());
  if (!assetName) {
    return {
      updated: false,
      previousVersion,
      latestVersion: null,
      summary: `no upstream build for ${process.platform}/${process.arch} — keeping the installed yt-dlp`,
    };
  }

  step("Checking for a newer release");
  let release: YtDlpRelease | null;
  try {
    release = parseRelease(await fetchJson(YTDLP_LATEST_RELEASE_URL));
  } catch (err) {
    return {
      updated: false,
      previousVersion,
      latestVersion: null,
      summary: `could not reach GitHub (${err instanceof Error ? err.message : String(err)}) — keeping ${previousVersion ?? "the installed yt-dlp"}`,
    };
  }
  if (!release) {
    return {
      updated: false,
      previousVersion,
      latestVersion: null,
      summary: "GitHub returned no release information — keeping the installed yt-dlp",
    };
  }

  if (!isUpdateAvailable(previousVersion, release.version)) {
    return {
      updated: false,
      previousVersion,
      latestVersion: release.version,
      summary: `already current (${previousVersion})`,
    };
  }

  const asset = findAsset(release, assetName);
  const checksums = findAsset(release, YTDLP_CHECKSUM_ASSET);
  if (!asset || !checksums) {
    return {
      updated: false,
      previousVersion,
      latestVersion: release.version,
      summary: `release ${release.version} publishes no usable ${assetName} — keeping ${previousVersion ?? "the installed yt-dlp"}`,
    };
  }

  await fs.mkdir(binDir(), { recursive: true });
  const tempPath = path.join(binDir(), `.${BINARY_NAME}-${process.pid}.part`);

  try {
    // Checksums first, and sequentially: the expected hash has to exist before a
    // 40 MB download is worth starting, and a rejected `Promise.all` would leave
    // the other transfer's failure unhandled.
    const expected = parseChecksums(await fetchText(checksums.url)).get(assetName);
    if (!expected) {
      throw new Error(`Release ${release.version} lists no checksum for ${assetName}`);
    }

    step(`Downloading yt-dlp ${release.version}`);
    const actualHash = await downloadAsset(asset.url, tempPath);
    if (expected !== actualHash) {
      throw new Error(
        `Checksum mismatch for ${assetName} (expected ${expected}, got ${actualHash})`,
      );
    }

    // A binary that cannot run is worse than a stale one — most likely the wrong
    // libc — so prove it works before it becomes the copy every download uses.
    step("Verifying the downloaded binary");
    await fs.chmod(tempPath, 0o755);
    const downloadedVersion = await readVersion(tempPath);
    if (!downloadedVersion) {
      throw new Error(`Downloaded ${assetName} does not run on this machine`);
    }

    // Atomic within the directory: a download in flight never sees a partial file
    // under the name it resolves.
    await fs.rename(tempPath, managedYtDlpPath());
    return {
      updated: true,
      previousVersion,
      latestVersion: release.version,
      summary: previousVersion
        ? `updated ${previousVersion} → ${downloadedVersion}`
        : `installed ${downloadedVersion}`,
    };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
