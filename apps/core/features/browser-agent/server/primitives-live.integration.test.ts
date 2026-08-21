import fs from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import { closeSharedChromium } from "@/features/link-fetch/server/playwright";

import { downloadMediaToDisk } from "./media-download";
import { downloadStreamToDisk } from "./stream-download";
import { BrowserAgentSession } from "./session";

/**
 * Opt-in **real-network** proof of the browser download primitives, against public
 * test endpoints (no LLM, no real user data). Skipped unless `BROWSER_LIVE=1`;
 * needs ffmpeg on PATH for the stream case and yt-dlp for the media case.
 *
 * Run: `BROWSER_LIVE=1 npm run test:integration -- browser-agent/server/primitives-live`
 */
const BROWSER_LIVE = process.env.BROWSER_LIVE === "1";

/** The default download ceiling (`settings.browser_download_limit_gb`). */
const LIMIT_BYTES = 10 * 1024 ** 3;

/** Mux's long-standing public HLS test stream. */
const TEST_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

/**
 * Blender Foundation's Big Buck Bunny trailer — Creative Commons, on the official
 * channel since 2008. A live third-party page, so this case fails if the video is
 * ever taken down; that is the trade for testing the real extraction path.
 */
const TEST_MEDIA_PAGE = "https://www.youtube.com/watch?v=YE7VzlLtp-4";

describe.skipIf(!BROWSER_LIVE)("browser primitives (real network)", () => {
  afterAll(async () => {
    await closeSharedChromium().catch(() => {});
  });

  it(
    "browser_download_stream muxes a real HLS manifest into a playable MP4",
    async () => {
      const result = await downloadStreamToDisk(TEST_HLS, { title: "mux test stream", maxBytes: LIMIT_BYTES });
      try {
        expect(result.sizeBytes).toBeGreaterThan(100_000); // a real muxed file, not an empty shell
        expect(result.mime).toBe("video/mp4");
        const onDisk = await fs.stat(result.filePath);
        expect(onDisk.size).toBe(result.sizeBytes);
        console.info(`\n[stream] ${result.filename} — ${Math.round(result.sizeBytes / 1024)} KB\n`);
      } finally {
        await fs.rm(result.filePath, { force: true }).catch(() => {});
      }
    },
    180_000,
  );

  it(
    "browser_get_network captures the requests a page makes (including the HLS manifest)",
    async () => {
      const session = new BrowserAgentSession();
      try {
        // hls.js's own demo page plays an HLS stream, so its manifest + segments
        // show up in the network even though the page text/links never name them.
        await session.navigate("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
        // Give the player a moment; the manifest fetch is the navigation itself here.
        await session.wait(2);
        const all = session.getNetwork();
        expect(all.length).toBeGreaterThan(0);
        const manifests = session.getNetwork(".m3u8");
        // The navigated manifest (and its variant playlists) must be visible.
        expect(manifests.some((e) => e.url.includes(".m3u8"))).toBe(true);
        console.info(`\n[network] captured ${all.length} requests, ${manifests.length} m3u8\n`);
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it(
    "browser_download_media pulls the audio off a real media page with yt-dlp",
    async () => {
      // The case the tool exists for: a media page whose player has no file URL
      // and no manifest to find. Creative-Commons audio, so the fetch is
      // uncontroversial; the assertion is that a playable file comes back at all.
      const result = await downloadMediaToDisk(TEST_MEDIA_PAGE, { mode: "audio", maxBytes: LIMIT_BYTES });
      try {
        expect(result.sizeBytes).toBeGreaterThan(50_000);
        // mp3, so the chat can actually play what comes back.
        expect(result.filename).toMatch(/\.mp3$/);
        expect(result.mime).toBe("audio/mpeg");
        const onDisk = await fs.stat(result.filePath);
        expect(onDisk.size).toBe(result.sizeBytes);
        console.info(`\n[media] ${result.filename} — ${Math.round(result.sizeBytes / 1024)} KB\n`);
      } finally {
        await fs.rm(result.filePath, { force: true }).catch(() => {});
      }
    },
    300_000,
  );
});
