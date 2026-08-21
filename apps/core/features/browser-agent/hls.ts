/**
 * Pure HLS master-playlist parsing for the stream downloader: pick the
 * best-quality video variant (plus its demuxed audio, when the master carries
 * audio separately) so a downloaded stream isn't ffmpeg's default lowest rung
 * and doesn't lose its soundtrack. No I/O, so it is unit-tested against real
 * playlists. Grounded in the MVP `web-browse/download.ts` `selectBestHlsInputs`.
 */

/** ffmpeg input URL(s) plus the `-map` args that pair them. */
export interface HlsInputs {
  inputUrls: string[];
  maps: string[];
}

/**
 * Choose the ffmpeg input(s) for an HLS master playlist: the highest-bandwidth
 * video variant, plus its demuxed audio rendition when the master carries audio
 * as a separate group. When the text is not a master (already a media playlist)
 * or has no variants, the URL is returned unchanged for ffmpeg to handle
 * directly. Relative variant/audio URIs resolve against `masterUrl`.
 */
export function selectBestHlsInputs(masterText: string, masterUrl: string): HlsInputs {
  const asIs: HlsInputs = { inputUrls: [masterUrl], maps: [] };
  if (!/#EXT-X-STREAM-INF/i.test(masterText)) return asIs;

  const lines = masterText.split(/\r?\n/);
  const variants: { bandwidth: number; uri: string; audioGroup: string | null }[] = [];
  const audios: { group: string; uri: string; isDefault: boolean; autoselect: boolean }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const bandwidth = Number(line.match(/[^-]BANDWIDTH=(\d+)/i)?.[1] ?? 0);
      const audioGroup = line.match(/AUDIO="([^"]*)"/i)?.[1] ?? null;
      // The variant URI is the next non-comment, non-empty line.
      const uri = lines
        .slice(i + 1)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      if (uri) variants.push({ bandwidth, uri, audioGroup });
    } else if (/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(line)) {
      const uri = line.match(/URI="([^"]*)"/i)?.[1];
      if (uri) {
        audios.push({
          group: line.match(/GROUP-ID="([^"]*)"/i)?.[1] ?? "",
          uri,
          isDefault: /DEFAULT=YES/i.test(line),
          autoselect: /AUTOSELECT=YES/i.test(line),
        });
      }
    }
  }

  if (variants.length === 0) return asIs;
  const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  const abs = (u: string): string => {
    try {
      return new URL(u, masterUrl).href;
    } catch {
      return u;
    }
  };

  // Audio demuxed into its own playlist → mux the chosen video + audio together.
  // Prefer the group's DEFAULT (then AUTOSELECT, then first) rendition.
  const groupAudio = audios.filter((a) => a.group === best.audioGroup);
  const audio =
    groupAudio.find((a) => a.isDefault) ?? groupAudio.find((a) => a.autoselect) ?? groupAudio[0];
  if (best.audioGroup && audio) {
    return { inputUrls: [abs(best.uri), abs(audio.uri)], maps: ["-map", "0:v:0", "-map", "1:a:0"] };
  }
  // Audio already muxed into the variant → a single input carries both streams.
  return { inputUrls: [abs(best.uri)], maps: [] };
}

/** True for an HLS/DASH manifest URL — muxed via ffmpeg, not GET-ed as a file. */
export function isStreamingManifest(url: string): boolean {
  return /\.(m3u8|mpd)(\/|\?|$)/i.test(url);
}
