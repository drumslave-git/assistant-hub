import { describe, expect, it } from "vitest";

import {
  buildDownloadFilename,
  extForUrl,
  formatBytes,
  formatTransferLine,
  mimeForFilename,
  primaryTitle,
  safeFilename,
} from "./files";

/**
 * Filenames come from untrusted page titles and URLs, so these assertions cover
 * the two failure modes that matter: a name that is unsafe on disk, and a name
 * with no meaningful extension.
 */

describe("safeFilename", () => {
  it("strips path separators and reserved characters", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename('a<b>c:"d"|e?f*g')).toBe("abcdefg");
  });

  it("falls back for an empty or dot-only name", () => {
    expect(safeFilename("")).toBe("download.bin");
    expect(safeFilename("..")).toBe("download.bin");
  });

  it("keeps unicode letters", () => {
    expect(safeFilename("Отчёт")).toBe("Отчёт");
  });
});

describe("extForUrl", () => {
  it("prefers the URL path extension", () => {
    expect(extForUrl("https://x.com/report.pdf?token=1", "application/octet-stream")).toBe("pdf");
  });

  it("falls back to the content type when the path has none", () => {
    expect(extForUrl("https://x.com/download", "application/pdf")).toBe("pdf");
    expect(extForUrl("https://x.com/file", "image/png")).toBe("png");
  });

  it("returns bin when nothing is known", () => {
    expect(extForUrl("https://x.com/thing", "application/x-unknown")).toBe("bin");
  });
});

describe("primaryTitle", () => {
  it("takes the segment before a site-name separator", () => {
    expect(primaryTitle("Annual Report — Acme Inc")).toBe("Annual Report");
    expect(primaryTitle("Widget | Store")).toBe("Widget");
  });

  it("keeps a short title with no separator whole", () => {
    expect(primaryTitle("Home")).toBe("Home");
  });
});

describe("formatBytes", () => {
  it("scales bytes to KB/MB/GB with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
    expect(formatBytes(Math.round(1.35 * 1024 * 1024 * 1024))).toBe("1.35 GB");
  });
});

describe("formatTransferLine", () => {
  it("shows the total when the source declared one", () => {
    expect(
      formatTransferLine({ receivedBytes: 1048576, totalBytes: 4194304, bytesPerSec: 524288 }),
    ).toBe("Downloading 1.0 MB / 4.0 MB (512 KB/s)");
  });

  it("omits the total when it is unknown", () => {
    expect(formatTransferLine({ receivedBytes: 2048, totalBytes: 0, bytesPerSec: 1024 })).toBe(
      "Downloading 2 KB (1 KB/s)",
    );
  });
});

describe("mimeForFilename", () => {
  it("types the containers yt-dlp produces", () => {
    expect(mimeForFilename("VIRUS (Fytch Remix).m4a")).toBe("audio/mp4");
    expect(mimeForFilename("clip.mp4")).toBe("video/mp4");
    expect(mimeForFilename("talk.opus")).toBe("audio/opus");
    expect(mimeForFilename("show.mkv")).toBe("video/x-matroska");
  });

  it("falls back to a generic binary for anything else", () => {
    expect(mimeForFilename("notes")).toBe("application/octet-stream");
    expect(mimeForFilename("archive.rar")).toBe("application/octet-stream");
  });
});

describe("buildDownloadFilename", () => {
  it("names the file from the title plus the URL extension", () => {
    expect(buildDownloadFilename("Q3 Report — Acme", "https://x.com/dl/123.pdf", "application/pdf")).toBe(
      "Q3 Report.pdf",
    );
  });

  it("falls back to the URL basename when there is no title", () => {
    expect(buildDownloadFilename(null, "https://x.com/files/data.csv", "text/csv")).toBe("data.csv");
  });
});
