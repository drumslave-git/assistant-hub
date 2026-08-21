import { describe, expect, it } from "vitest";

import { isStreamingManifest, selectBestHlsInputs } from "./hls";

/**
 * The stream downloader hands ffmpeg whatever this picks, so a wrong choice means
 * the lowest quality or a silent (audio-less) video. These pin the two things that
 * matter: the highest-bandwidth variant wins, and demuxed audio is paired with it.
 */

describe("isStreamingManifest", () => {
  it("recognizes m3u8/mpd manifests, with or without query", () => {
    expect(isStreamingManifest("https://x/master.m3u8")).toBe(true);
    expect(isStreamingManifest("https://x/stream.mpd?token=1")).toBe(true);
    expect(isStreamingManifest("https://x/video.mp4")).toBe(false);
    expect(isStreamingManifest("https://x/page")).toBe(false);
  });
});

describe("selectBestHlsInputs", () => {
  it("returns the URL unchanged when the text is not a master playlist", () => {
    const media = "#EXTM3U\n#EXTINF:6,\nseg0.ts\n#EXTINF:6,\nseg1.ts";
    expect(selectBestHlsInputs(media, "https://x/media.m3u8")).toEqual({
      inputUrls: ["https://x/media.m3u8"],
      maps: [],
    });
  });

  it("picks the highest-bandwidth variant", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000",
      "low.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=4000000",
      "high.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000",
      "mid.m3u8",
    ].join("\n");
    const out = selectBestHlsInputs(master, "https://x/master.m3u8");
    expect(out.inputUrls).toEqual(["https://x/high.m3u8"]);
    expect(out.maps).toEqual([]);
  });

  it("pairs the chosen video with its demuxed default audio rendition", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="aud"',
      "video/hi.m3u8",
    ].join("\n");
    const out = selectBestHlsInputs(master, "https://cdn.example/live/master.m3u8");
    expect(out.inputUrls).toEqual([
      "https://cdn.example/live/video/hi.m3u8",
      "https://cdn.example/live/audio/en.m3u8",
    ]);
    expect(out.maps).toEqual(["-map", "0:v:0", "-map", "1:a:0"]);
  });
});
