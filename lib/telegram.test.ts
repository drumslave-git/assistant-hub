import { describe, expect, it } from "vitest";

import { findMessageRefs, isGroupChatId, messageLinkBase, telegramFileKind } from "./telegram";

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

describe("messageLinkBase", () => {
  it("builds the t.me prefix for a supergroup by dropping the -100", () => {
    expect(messageLinkBase("-1001234567890")).toBe("https://t.me/c/1234567890");
  });

  it("has no link form for a basic group or a private chat", () => {
    // Telegram mints no per-message URL for either — returning null is what
    // keeps the bot from writing links that go nowhere.
    expect(messageLinkBase("-987654321")).toBeNull();
    expect(messageLinkBase("42")).toBeNull();
  });
});

describe("findMessageRefs", () => {
  it("collects the ids a reply cites, de-duplicated and in order", () => {
    expect(findMessageRefs("first in #13488, others under #15114 and #15115, again #13488")).toEqual(
      [13488, 15114, 15115],
    );
  });

  it("reads the numero sign as a citation too", () => {
    expect(findMessageRefs("see \u211613488")).toEqual([13488]);
  });

  it("ignores word hashtags and URL fragments", () => {
    expect(findMessageRefs("#weekend https://e.com/a#13488 code#7")).toEqual([]);
  });

  it("finds a citation at the very start of the text", () => {
    expect(findMessageRefs("#13488 is the one")).toEqual([13488]);
  });
});
