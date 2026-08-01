/**
 * Pure helpers for keeping yt-dlp current: which prebuilt asset this machine
 * needs, what the release's checksum file says its hash should be, and which of
 * two yt-dlp versions is newer. No I/O and no node imports, so the whole update
 * contract is unit-testable without the network or the disk — the same split
 * `ytdlp.ts` uses for the download contract.
 *
 * This exists because yt-dlp is a moving target in a way the rest of the stack is
 * not: the sites it extracts from change on purpose, and a stale build does not
 * degrade — it fails *every* media page at once. Distro packages are frozen per
 * release (Alpine's was four months behind upstream when this was written), so a
 * current binary has to come from upstream, on its own schedule rather than the
 * app's redeploy schedule.
 */

/** GitHub's "newest published release" endpoint for the yt-dlp repository. */
export const YTDLP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

/** The release asset listing one SHA-256 per file in the same release. */
export const YTDLP_CHECKSUM_ASSET = "SHA2-256SUMS";

/**
 * Only assets served from the yt-dlp release path are ever fetched. The URL comes
 * from a JSON document off the network, and the thing it points at is written to
 * disk and executed — so it is checked against a literal prefix rather than
 * trusted because the response looked like GitHub's.
 */
const ASSET_URL_PREFIX = "https://github.com/yt-dlp/yt-dlp/releases/download/";

/** One downloadable file in a GitHub release, reduced to what the updater uses. */
export interface ReleaseAsset {
  name: string;
  url: string;
}

/** A published yt-dlp release. */
export interface YtDlpRelease {
  /** Release tag, which for yt-dlp is the version (`2026.07.04`). */
  version: string;
  assets: ReleaseAsset[];
}

/** The machine an update is being resolved for. */
export interface PlatformTarget {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** True on a musl libc (Alpine), which needs the `musllinux` build. */
  musl: boolean;
}

/**
 * The self-contained yt-dlp build for a machine, or null when upstream publishes
 * no single-file binary for it.
 *
 * These are PyInstaller bundles: no python, no pip, nothing to install — one
 * executable file, which is what makes an unattended swap safe. The musl/glibc
 * split is not cosmetic; the wrong one does not start at all, which is why
 * {@link import("./server/ytdlp-binary").updateYtDlp} runs a downloaded binary
 * before it replaces anything.
 *
 * Deliberately narrow: the armv7l and Windows builds ship only as archives, and
 * unpacking one is more machinery than an unsupported platform is worth. Those
 * machines keep whatever yt-dlp is on `PATH`.
 */
export function ytDlpAssetName(target: PlatformTarget): string | null {
  if (target.platform === "darwin") return "yt-dlp_macos";
  if (target.platform !== "linux") return null;
  const base = target.musl ? "yt-dlp_musllinux" : "yt-dlp_linux";
  if (target.arch === "x64") return base;
  if (target.arch === "arm64") return `${base}_aarch64`;
  return null;
}

/** Whether a release-asset URL is one this updater is willing to download. */
export function isTrustedAssetUrl(url: string): boolean {
  return url.startsWith(ASSET_URL_PREFIX);
}

/**
 * Read a release's JSON into the shape the updater uses, or null when the
 * response is not a release (GitHub answers rate limiting with a plain object
 * carrying a `message`, and that must read as "no update information" rather
 * than crash the nightly job).
 */
export function parseRelease(body: unknown): YtDlpRelease | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const version = typeof record.tag_name === "string" ? record.tag_name.trim() : "";
  if (!version) return null;

  const assets: ReleaseAsset[] = [];
  for (const entry of Array.isArray(record.assets) ? record.assets : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const asset = entry as Record<string, unknown>;
    const name = typeof asset.name === "string" ? asset.name : "";
    const url =
      typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (name && url) assets.push({ name, url });
  }
  return { version, assets };
}

/** The named asset of a release, or null when it is absent or served elsewhere. */
export function findAsset(release: YtDlpRelease, name: string): ReleaseAsset | null {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset || !isTrustedAssetUrl(asset.url)) return null;
  return asset;
}

/**
 * Parse a `SHA2-256SUMS` body (`<hex>  <filename>` per line) into filename → hash.
 * Hashes are lowercased so a comparison never fails on case alone.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/**
 * The version out of `yt-dlp --version`, which prints the bare version and
 * nothing else on a release build. Tolerant of extra lines because a build from
 * source prints its commit alongside.
 */
export function parseYtDlpVersion(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Compare two yt-dlp versions. They are dates (`2026.07.04`, with a fourth
 * component on nightlies), so a component-wise numeric compare orders them
 * correctly — a string compare would not, once a component loses its zero
 * padding.
 *
 * Returns a negative number when `a` is older, 0 when equal, positive when newer.
 */
export function compareYtDlpVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Whether `candidate` is worth installing over `installed`. An unknown installed
 * version (nothing on `PATH`, or output this parser did not recognize) counts as
 * "worth installing" — that is the case where an update matters most.
 */
export function isUpdateAvailable(installed: string | null, candidate: string): boolean {
  if (!installed) return true;
  return compareYtDlpVersions(candidate, installed) > 0;
}
