import { describe, expect, it } from "vitest";

import {
  compareYtDlpVersions,
  findAsset,
  isTrustedAssetUrl,
  isUpdateAvailable,
  parseChecksums,
  parseRelease,
  parseYtDlpVersion,
  ytDlpAssetName,
} from "./ytdlp-release";

/**
 * The yt-dlp update contract, without the network or the disk: which build a
 * machine needs, what a release document and its checksum file actually say, and
 * which of two versions is newer.
 */

describe("ytDlpAssetName", () => {
  it("picks the musl build on Alpine and the glibc build elsewhere", () => {
    expect(ytDlpAssetName({ platform: "linux", arch: "x64", musl: true })).toBe(
      "yt-dlp_musllinux",
    );
    expect(ytDlpAssetName({ platform: "linux", arch: "x64", musl: false })).toBe("yt-dlp_linux");
  });

  it("picks the aarch64 variant on arm64", () => {
    expect(ytDlpAssetName({ platform: "linux", arch: "arm64", musl: true })).toBe(
      "yt-dlp_musllinux_aarch64",
    );
    expect(ytDlpAssetName({ platform: "linux", arch: "arm64", musl: false })).toBe(
      "yt-dlp_linux_aarch64",
    );
  });

  it("has a build for macOS regardless of architecture", () => {
    expect(ytDlpAssetName({ platform: "darwin", arch: "arm64", musl: false })).toBe(
      "yt-dlp_macos",
    );
  });

  it("returns null where upstream ships no single-file binary", () => {
    // armv7l and Windows exist only as archives; unpacking one is more machinery
    // than an unsupported platform is worth, so those keep the PATH yt-dlp.
    expect(ytDlpAssetName({ platform: "linux", arch: "arm", musl: false })).toBeNull();
    expect(ytDlpAssetName({ platform: "win32", arch: "x64", musl: false })).toBeNull();
  });
});

describe("isTrustedAssetUrl", () => {
  it("accepts the yt-dlp release download path", () => {
    expect(
      isTrustedAssetUrl(
        "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_musllinux",
      ),
    ).toBe(true);
  });

  it("rejects anything else — the URL comes from the network and is executed", () => {
    expect(isTrustedAssetUrl("https://example.com/yt-dlp_musllinux")).toBe(false);
    expect(
      isTrustedAssetUrl("https://github.com/someone-else/yt-dlp/releases/download/x/yt-dlp"),
    ).toBe(false);
    expect(isTrustedAssetUrl("http://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp")).toBe(
      false,
    );
  });
});

describe("parseRelease", () => {
  const url = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_musllinux";

  it("reads the tag and its downloadable assets", () => {
    const release = parseRelease({
      tag_name: "2026.07.04",
      assets: [{ name: "yt-dlp_musllinux", browser_download_url: url }],
    });
    expect(release).toEqual({
      version: "2026.07.04",
      assets: [{ name: "yt-dlp_musllinux", url }],
    });
  });

  it("returns null for a rate-limit or error body rather than throwing", () => {
    expect(parseRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("not json")).toBeNull();
  });

  it("drops malformed asset entries instead of failing the whole release", () => {
    const release = parseRelease({
      tag_name: "2026.07.04",
      assets: [{ name: "yt-dlp_musllinux" }, null, { name: "ok", browser_download_url: url }],
    });
    expect(release?.assets).toEqual([{ name: "ok", url }]);
  });
});

describe("findAsset", () => {
  it("refuses an asset served from somewhere other than the yt-dlp release", () => {
    const release = {
      version: "2026.07.04",
      assets: [{ name: "yt-dlp_musllinux", url: "https://elsewhere.example/yt-dlp" }],
    };
    expect(findAsset(release, "yt-dlp_musllinux")).toBeNull();
  });

  it("returns null when the release does not publish the asset", () => {
    expect(findAsset({ version: "2026.07.04", assets: [] }, "yt-dlp_musllinux")).toBeNull();
  });
});

describe("parseChecksums", () => {
  it("maps each filename to its lowercase hash", () => {
    const sums = parseChecksums(
      [
        "495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd  yt-dlp",
        "F7439EC2E3FFE69E06AC233F83F0D9687B89105939129BDDCBF74E5DE0F2B40E  yt-dlp_musllinux",
        "",
        "garbage line",
      ].join("\n"),
    );
    expect(sums.get("yt-dlp_musllinux")).toBe(
      "f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e",
    );
    expect(sums.size).toBe(2);
  });
});

describe("parseYtDlpVersion", () => {
  it("reads the bare version a release build prints", () => {
    expect(parseYtDlpVersion("2026.03.17\n")).toBe("2026.03.17");
  });

  it("finds the version among a source build's extra lines", () => {
    expect(parseYtDlpVersion("2026.07.04.232815\nCurrent Branch: master\n")).toBe(
      "2026.07.04.232815",
    );
  });

  it("returns null when the output is not a version at all", () => {
    expect(parseYtDlpVersion("")).toBeNull();
    expect(parseYtDlpVersion("command not found")).toBeNull();
  });
});

describe("compareYtDlpVersions", () => {
  it("orders by date component, not lexically", () => {
    // A string compare gets this wrong the moment a component loses zero padding.
    expect(compareYtDlpVersions("2026.7.4", "2026.03.17")).toBeGreaterThan(0);
    expect(compareYtDlpVersions("2026.03.17", "2026.07.04")).toBeLessThan(0);
    expect(compareYtDlpVersions("2026.07.04", "2026.07.04")).toBe(0);
  });

  it("treats a nightly's fourth component as newer than the plain release", () => {
    expect(compareYtDlpVersions("2026.07.04.232815", "2026.07.04")).toBeGreaterThan(0);
  });
});

describe("isUpdateAvailable", () => {
  it("is true when nothing is installed — that is when an update matters most", () => {
    expect(isUpdateAvailable(null, "2026.07.04")).toBe(true);
  });

  it("is false for the same or an older upstream version", () => {
    expect(isUpdateAvailable("2026.07.04", "2026.07.04")).toBe(false);
    expect(isUpdateAvailable("2026.07.04", "2026.03.17")).toBe(false);
  });

  it("is true for a newer upstream version", () => {
    expect(isUpdateAvailable("2026.03.17", "2026.07.04")).toBe(true);
  });
});
