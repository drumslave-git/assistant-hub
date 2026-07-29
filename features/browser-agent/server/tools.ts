import "server-only";

import { readFile } from "node:fs/promises";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import type { McpToolCallResult } from "@/server/mcp/tool-result";

import { formatBytes, formatTransferLine } from "../files";
import { formatSnapshot, type PageSnapshot } from "../snapshot";
import type { MediaMode } from "../ytdlp";
import type { BrowserDownloadRecord } from "../types";
import { downloadToDisk, type DiskDownload } from "./download";
import { downloadMediaToDisk, YtDlpMissingError } from "./media-download";
import { runBrowserSearch } from "./search";
import { downloadStreamToDisk, FfmpegMissingError } from "./stream-download";
import type { BrowserAgentSession, NetworkEntry } from "./session";

/**
 * The browser agent's generic toolset (recorded decision: no scenario-specific
 * tools — the model composes primitives instead of the code encoding any one
 * task): search, navigate, back, click, type, scroll, read page, read raw source,
 * inspect network requests, screenshot, wait, download a direct file, download an
 * HLS/DASH stream, download a media page. Finding "the video" is the model's job —
 * it reads the page or the network, picks the URL, and calls the matching download
 * tool — not a media-sniffing heuristic baked in here.
 *
 * Three download tools rather than one because the three cases have genuinely
 * different inputs: a whole-file URL, a manifest URL, and — for a site whose player
 * derives ciphered per-session stream URLs in its own JavaScript — the page URL
 * itself, handed to yt-dlp.
 *
 * These are plain OpenAI tool definitions for the agent's own tool loop — they
 * are NOT MCP tools and are never offered to the main chat model; only the
 * `browse_web` dispatch tool is (see `mcp-tools.ts`).
 */

/** A file collected during a run, delivered to the chat as it lands. */
export interface CollectedFile {
  buffer: Buffer;
  filename: string;
  mime: string;
}

/** Collaborators one run's dispatcher acts through. */
export interface AgentToolContext {
  session: BrowserAgentSession;
  /** Whether the run was started by the owner — gates browser_download. */
  isOwner: boolean;
  /** Largest file (MB) that is also attached to the chat. */
  downloadMaxMb: number;
  /**
   * Hard ceiling in bytes on any single download, whichever tool runs
   * (`settings.browser_download_limit_gb`). A disk guard, never a quality choice.
   */
  downloadLimitBytes: number;
  /** Every completed download, for the run row + end-of-run recap. */
  downloads: BrowserDownloadRecord[];
  /** Called before each action starts, with a short label + the current URL. */
  onAction: (action: string, url: string | null) => void | Promise<void>;
  /**
   * Called after each action finishes, with its outcome — the activity-feed entry.
   * `action` is the same label the matching {@link onAction} used.
   */
  onStep: (step: {
    tool: string;
    action: string;
    url: string | null;
    ok: boolean;
    summary: string;
  }) => void | Promise<void>;
  /** Live download progress line while a file/stream downloads (null when idle). */
  onProgress?: (line: string | null) => void;
  /**
   * Store one captured screenshot (bytes never travel through the trace).
   * Resolves the stored sequence number, for the result text.
   */
  onScreenshot: (shot: { buffer: Buffer; url: string | null; title: string | null }) => Promise<number>;
  /**
   * Report ONE finished download to the chat immediately — a small file as an
   * attachment, a large one as a text line — so the user sees every file arrive
   * instead of a batch at the end of the run.
   */
  onDownload: (record: BrowserDownloadRecord, file: CollectedFile | null) => Promise<void>;
}

function fn(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

/** OpenAI tool definitions for the browser agent loop. */
export const BROWSER_AGENT_TOOLS: ChatCompletionFunctionTool[] = [
  fn(
    "browser_search",
    "Search the web. Start here whenever you were NOT given a URL and need to FIND pages, sources, facts, news, or a site for the goal. It runs the query on a live search engine (trying several, so a blocked or captcha'd one does not stop you) and returns the top 5 results as a numbered list of title + URL + snippet. Then YOU choose what to open: navigate to the results worth reading — one, several, or all of them — and read the actual pages. The snippets are only previews, so do not answer from them alone.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search-engine query — keywords, in the language the sources are in",
        },
      },
      required: ["query"],
    },
  ),
  fn(
    "browser_navigate",
    "Open a URL in the browser and return the page's text and interactive elements. Start here when you already have a URL to open.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to open" },
      },
      required: ["url"],
    },
  ),
  fn(
    "browser_back",
    "Go back one step in the browser history. Returns the new page state.",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_click",
    "Click an interactive element by its ref number (from the last page state's INTERACTIVE ELEMENTS list). Returns the new page state.",
    {
      type: "object",
      properties: {
        ref: { type: "number", description: "The [N] ref of the element to click" },
      },
      required: ["ref"],
    },
  ),
  fn(
    "browser_type",
    "Type text into an input/textarea by its ref number, optionally submitting (Enter). Returns the new page state.",
    {
      type: "object",
      properties: {
        ref: { type: "number", description: "The [N] ref of the input element" },
        text: { type: "string", description: "Text to type" },
        submit: {
          type: "boolean",
          description: "Press Enter after typing (e.g. to run a search)",
        },
      },
      required: ["ref", "text"],
    },
  ),
  fn(
    "browser_scroll",
    "Scroll the page up or down by one or more screens, to reach content below the fold. Returns the new page state.",
    {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
        pages: { type: "number", description: "How many screens to scroll (default 1)" },
      },
      required: ["direction"],
    },
  ),
  fn(
    "browser_read",
    "Re-read the current page (after it changed). Returns text + elements.",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_source",
    "Read the current page's raw HTML source, in bounded chunks. Use when the visible text is not enough (hidden data, script-embedded values, a media/file URL buried in inline scripts); pass a larger offset to read further into the document.",
    {
      type: "object",
      properties: {
        offset: { type: "number", description: "Character offset to start from (default 0)" },
      },
    },
  ),
  fn(
    "browser_get_network",
    "List the network requests the current page has made (URL, method, resource type, status, content-type). This is how you find the REAL file or stream URL that a player or the page loaded — e.g. an .mp4/.m3u8/.mpd a video player fetched, or a file a button pointed at — which is often NOT visible in the page text or links. Interact with the page first (play/scroll/click) so it loads what you want, then read the network here, pick the right URL, and download it with the matching download tool: a direct file (.mp4/.pdf/…) versus a streaming manifest (.m3u8/.mpd). Do NOT use this to hunt for a media URL on a video/music site (YouTube, YouTube Music, SoundCloud, Vimeo, TikTok, …) — those players build ciphered one-off URLs that will not work outside the page. Use browser_download_media with the page URL for those.",
    {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description:
            "Optional case-insensitive substring to match against the URL or content-type (e.g. \".mp4\", \".m3u8\", \"video\", \"audio\"). Omit to list everything.",
        },
      },
    },
  ),
  fn(
    "browser_screenshot",
    "Capture a screenshot of the current page. The image is shown to you so you can see the page visually — use it when the text snapshot is not enough (layouts, images, charts, rendering issues).",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_wait",
    "Wait for a slow page to finish loading or updating (bounded seconds), then return the fresh page state.",
    {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long to wait (1–30 seconds)" },
      },
      required: ["seconds"],
    },
  ),
  fn(
    "browser_download_file",
    "Download a DIRECT file URL — one URL that returns the whole file (.mp4, .pdf, .zip, .jpg …) — to the server's downloads folder (owner-started runs only). If the file URL is not an obvious link, find it first by inspecting the page source or the page's network requests. For a streaming video served as an HLS/DASH manifest (.m3u8/.mpd), use browser_download_stream instead; for a video/music site page (YouTube, YouTube Music, SoundCloud, Vimeo, TikTok …), use browser_download_media — this one only fetches a single whole-file URL. The file is named automatically from the page title — do NOT pass a filename. Small files are also attached to the chat; large ones are reported by name.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL of the direct file" },
      },
      required: ["url"],
    },
  ),
  fn(
    "browser_download_stream",
    "Download a STREAMING video/audio from its HLS/DASH manifest URL (an .m3u8 or .mpd) — the format most in-browser video players use, where the media is split into many segments with no single file to GET. It assembles the segments into one MP4 at the best available quality. Find the manifest URL first by inspecting the page source or the page's network requests (look for .m3u8/.mpd). If the page is on a video/music site (YouTube, YouTube Music, SoundCloud, Vimeo, TikTok …) there is no manifest to find — use browser_download_media instead. Owner-started runs only. Small results are attached to the chat; large ones are reported by name.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL of the .m3u8/.mpd manifest" },
      },
      required: ["url"],
    },
  ),
  fn(
    "browser_download_media",
    "Download the video or the audio of a MEDIA PAGE — YouTube, YouTube Music, SoundCloud, Vimeo, TikTok, Twitter/X, Instagram, Bandcamp, Twitch, a podcast page, a news video page, and ~1800 other sites. Pass the PAGE url the human would open (the one with the watch/video/track id), NOT a media file url — this tool extracts the media itself. This is the ONLY tool that works on those sites: their players build ciphered, one-off stream urls in their own JavaScript, so there is no file to GET and no .m3u8 to find — do not waste steps reading the page source or the network requests looking for one, and never report back that the site 'has no download button' or that the user should download it themselves. Use it whenever the goal is to download/save/get a song, track, video, clip, episode or podcast from such a page. Owner-started runs only. The file is named from the media's own title — do NOT pass a filename. Small results are attached to the chat; large ones are reported by name.",
    {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public http(s) URL of the media PAGE (e.g. https://www.youtube.com/watch?v=…)",
        },
        mode: {
          type: "string",
          enum: ["audio", "video"],
          description:
            "\"audio\" for a song, track, music, a podcast or anything the user wants to listen to (best available audio, much smaller); \"video\" for a video or clip (best available video + audio). Default \"video\".",
        },
      },
      required: ["url"],
    },
  ),
];

function snapshotResult(snapshot: PageSnapshot): McpToolCallResult {
  return { text: formatSnapshot(snapshot) };
}

function errorResult(message: string): McpToolCallResult {
  return { text: `Error: ${message}`, isError: true };
}

function num(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Build the dispatcher the agent's tool loop calls for each browser action. Every
 * call is bracketed with a live-feed pair: {@link AgentToolContext.onAction} fires
 * as the action starts (drives the "current action" indicator) and
 * {@link AgentToolContext.onStep} fires when it finishes with its outcome (the
 * activity-feed entry). Download tools additionally stream byte/mux progress
 * through {@link AgentToolContext.onProgress}.
 */
export function makeBrowserToolDispatcher(ctx: AgentToolContext) {
  return async (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
    // Capture the human action label the cases pass to onAction, so the completed
    // step is recorded under the same label the live indicator showed.
    let action = name;
    const local: AgentToolContext = {
      ...ctx,
      onAction: async (label, url) => {
        action = label;
        await ctx.onAction(label, url);
      },
    };

    let result: McpToolCallResult;
    try {
      result = await dispatchTool(local, name, args);
    } catch (err) {
      result = errorResult(err instanceof Error ? err.message : "Tool failed");
    }

    ctx.onProgress?.(null); // the action is over — clear any lingering progress line
    await ctx.onStep({
      tool: name,
      action,
      url: ctx.session.currentUrl(),
      ok: !result.isError,
      summary: summarizeResult(result),
    });
    return result;
  };
}

/** Run one browser tool. Throws are caught by the wrapper and recorded as a step. */
async function dispatchTool(
  ctx: AgentToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  switch (name) {
    case "browser_search": {
      const query = str(args, "query").trim();
      if (!query) return errorResult("query is required");
      // Each attempt re-labels the action, so the live indicator (and the step the
      // feed records) names the source that actually answered.
      const result = await runBrowserSearch(query, {
        navigate: (url) => ctx.session.navigate(url),
        links: () => ctx.session.links(),
        wait: (seconds) => ctx.session.wait(seconds),
        onAttempt: (source) =>
          ctx.onAction(`search "${query}" on ${source}`, ctx.session.currentUrl()),
      });
      return { text: result.text, ...(result.isError ? { isError: true } : {}) };
    }
    case "browser_navigate": {
      const url = str(args, "url");
      await ctx.onAction(`navigate ${url}`, ctx.session.currentUrl());
      return snapshotResult(await ctx.session.navigate(url));
    }
    case "browser_back": {
      await ctx.onAction("back", ctx.session.currentUrl());
      return snapshotResult(await ctx.session.back());
    }
    case "browser_click": {
      const ref = num(args, "ref");
      if (ref == null) return errorResult("ref is required");
      await ctx.onAction(`click [${ref}]`, ctx.session.currentUrl());
      return snapshotResult(await ctx.session.click(ref));
    }
    case "browser_type": {
      const ref = num(args, "ref");
      if (ref == null) return errorResult("ref is required");
      const text = str(args, "text");
      const submit = args.submit === true;
      await ctx.onAction(`type into [${ref}]`, ctx.session.currentUrl());
      return snapshotResult(await ctx.session.type(ref, text, submit));
    }
    case "browser_scroll": {
      const direction = str(args, "direction") === "up" ? "up" : "down";
      const pages = num(args, "pages") ?? 1;
      await ctx.onAction(`scroll ${direction}`, ctx.session.currentUrl());
      return snapshotResult(await ctx.session.scroll(direction, pages));
    }
    case "browser_read": {
      await ctx.onAction("read page", ctx.session.currentUrl());
      return snapshotResult(await ctx.session.read());
    }
    case "browser_source": {
      const offset = num(args, "offset") ?? 0;
      await ctx.onAction(`read source @${offset}`, ctx.session.currentUrl());
      const { html, offset: start, total } = await ctx.session.source(offset);
      const end = start + html.length;
      const header =
        `PAGE SOURCE (characters ${start}–${end} of ${total}` +
        (end < total ? `; call again with offset ${end} for more` : "; end of document") +
        `):\n`;
      return { text: header + html };
    }
    case "browser_get_network": {
      const filter = str(args, "filter") || undefined;
      await ctx.onAction(filter ? `network ~${filter}` : "network", ctx.session.currentUrl());
      return { text: formatNetwork(ctx.session.getNetwork(filter)) };
    }
    case "browser_screenshot": {
      await ctx.onAction("screenshot", ctx.session.currentUrl());
      const buffer = await ctx.session.screenshot();
      const meta = await ctx.session.pageMeta();
      const seq = await ctx.onScreenshot({ buffer, url: meta.url, title: meta.title });
      return {
        text: `Screenshot #${seq + 1} captured (shown to you as an image).`,
        images: [`data:image/jpeg;base64,${buffer.toString("base64")}`],
      };
    }
    case "browser_wait": {
      const seconds = num(args, "seconds") ?? 3;
      await ctx.onAction(`wait ${seconds}s`, ctx.session.currentUrl());
      return snapshotResult(await ctx.session.wait(seconds));
    }
    case "browser_download_file": {
      if (!ctx.isOwner) return errorResult(DOWNLOAD_DENIED);
      const url = str(args, "url");
      await ctx.onAction(`download file ${url}`, ctx.session.currentUrl());
      const meta = await ctx.session.pageMeta();
      const result = await downloadToDisk(url, {
        maxBytes: ctx.downloadLimitBytes,
        title: meta.title,
        onProgress: (p) => ctx.onProgress?.(formatTransferLine(p)),
      });
      return finishDownload(ctx, result, meta.url ?? url);
    }
    case "browser_download_stream": {
      if (!ctx.isOwner) return errorResult(DOWNLOAD_DENIED);
      const url = str(args, "url");
      await ctx.onAction(`download stream ${url}`, ctx.session.currentUrl());
      const meta = await ctx.session.pageMeta();
      try {
        const result = await downloadStreamToDisk(url, {
          maxBytes: ctx.downloadLimitBytes,
          title: meta.title,
          onProgress: (p) =>
            ctx.onProgress?.(`Assembling stream — ${formatBytes(p.outputBytes)} written, ${p.time} muxed`),
        });
        return finishDownload(ctx, result, meta.url ?? url);
      } catch (err) {
        // ffmpeg missing is an operator-fixable environment fact — say so plainly
        // rather than as a generic tool failure the agent might paper over.
        if (err instanceof FfmpegMissingError) return errorResult(err.message);
        throw err;
      }
    }
    case "browser_download_media": {
      if (!ctx.isOwner) return errorResult(DOWNLOAD_DENIED);
      const url = str(args, "url");
      const mode: MediaMode = str(args, "mode") === "audio" ? "audio" : "video";
      await ctx.onAction(`download ${mode} ${url}`, ctx.session.currentUrl());
      try {
        // No page title is read here: yt-dlp names the file from the media's own
        // metadata, which is better than the page title the other tools use, and
        // the agent may call this without ever navigating to the page.
        const result = await downloadMediaToDisk(url, {
          mode,
          maxBytes: ctx.downloadLimitBytes,
          onProgress: (p) => ctx.onProgress?.(formatTransferLine(p)),
        });
        return finishDownload(ctx, result, url);
      } catch (err) {
        // yt-dlp missing is an operator-fixable environment fact, like ffmpeg —
        // say so plainly rather than as a generic tool failure.
        if (err instanceof YtDlpMissingError) return errorResult(err.message);
        throw err;
      }
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

const DOWNLOAD_DENIED = "Downloads are disabled for this run (only the owner can download files).";

/** The first non-empty line of a tool result, bounded — the activity-feed summary. */
function summarizeResult(result: McpToolCallResult): string {
  const firstLine = result.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

/**
 * Shared post-download delivery: record the file, decide inline vs link by the
 * chat attach limit, hand it to the run's delivery sink, and return the model's
 * result text. Both download tools (file and stream) end here. The filename comes
 * from the page it was fetched on, never from the model (which is inconsistent).
 */
async function finishDownload(
  ctx: AgentToolContext,
  result: DiskDownload,
  sourceUrl: string,
): Promise<McpToolCallResult> {
  const mb = Math.round(result.sizeBytes / 1024 / 1024);
  const inline = result.sizeBytes <= ctx.downloadMaxMb * 1024 * 1024;
  const record: BrowserDownloadRecord = {
    sourceUrl,
    filename: result.filename,
    sizeBytes: result.sizeBytes,
    inline,
  };
  ctx.downloads.push(record);
  const file: CollectedFile | null = inline
    ? { buffer: await readFile(result.filePath), filename: result.filename, mime: result.mime }
    : null;
  await ctx.onDownload(record, file);
  return {
    text:
      `Saved to the downloads folder as "${result.filename}" (${mb} MB).` +
      (inline
        ? " Attaching it to the chat now."
        : " It is too large to attach here — tell the user the filename and that it is in the downloads folder. Do NOT paste a URL."),
  };
}

/** Render observed network responses for the agent (newest last, bounded). */
function formatNetwork(entries: NetworkEntry[]): string {
  if (entries.length === 0) {
    return "No network requests recorded yet. Navigate, play, or interact with the page first, then read the network again.";
  }
  // Cap the rendered list so a chatty page can't blow the tool result out; the
  // newest requests (a player's media fetches happen after load) matter most.
  const shown = entries.slice(-120);
  const omitted = entries.length - shown.length;
  const lines = shown.map(
    (e) => `[${e.resourceType}] ${e.status} ${e.contentType || "?"} ${e.url}`,
  );
  const header =
    `NETWORK REQUESTS (${shown.length}${omitted > 0 ? ` of ${entries.length}, oldest ${omitted} omitted` : ""}):`;
  return [header, ...lines].join("\n");
}
