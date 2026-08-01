import { describe, expect, it } from "vitest";

import { isGroupChatId, telegramFileKind } from "./telegram";

describe("isGroupChatId", () => {
  it("reads the sign convention", () => {
    expect(isGroupChatId("-1001234")).toBe(true);
    expect(isGroupChatId("1234")).toBe(false);
  });
});

describe("telegramFileKind", () => {
  it("sends streamable video containers as video", () => {
    expect(telegramFileKind("video/mp4")).toBe("video");
    expect(telegramFileKind("video/quicktime")).toBe("video");
  });

  it("sends music-player formats as audio", () => {
    expect(telegramFileKind("audio/mpeg")).toBe("audio");
    expect(telegramFileKind("audio/mp4")).toBe("audio");
  });

  it("sends everything else as a document, including unplayable media containers", () => {
    // mkv/webm/opus render as a generic file in Telegram either way — sending
    // them as a document at least names them honestly.
    expect(telegramFileKind("video/x-matroska")).toBe("document");
    expect(telegramFileKind("video/webm")).toBe("document");
    expect(telegramFileKind("audio/opus")).toBe("document");
    expect(telegramFileKind("application/pdf")).toBe("document");
    expect(telegramFileKind("application/octet-stream")).toBe("document");
  });

  it("tolerates parameters, casing, and a missing type", () => {
    expect(telegramFileKind("Video/MP4; codecs=avc1")).toBe("video");
    expect(telegramFileKind(undefined)).toBe("document");
    expect(telegramFileKind(null)).toBe("document");
    expect(telegramFileKind("")).toBe("document");
  });
});
