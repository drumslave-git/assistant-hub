import { describe, expect, it } from "vitest";

import { makeMessage as msg } from "@/test/__mocks__/telegram";
import { detectMessageMedia, findReplyMediaMessage, messageHasVisionMedia } from "./detect";

describe("detectMessageMedia", () => {
  it("returns the largest photo size", () => {
    const detected = detectMessageMedia(
      msg({
        photo: [
          { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
          { file_id: "big", file_unique_id: "b", width: 1280, height: 1280 },
        ],
      }),
    );
    expect(detected).toEqual({
      kind: "photo",
      fileId: "big",
      fileUniqueId: "b",
      visionHint: null,
      isVideo: false,
      isAudio: false,
      thumbnailFileId: null,
      durationSec: null,
    });
  });

  it("decodes a static sticker directly and hints its emoji/pack", () => {
    const detected = detectMessageMedia(
      msg({
        sticker: {
          file_id: "stk",
          file_unique_id: "u",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          emoji: "😀",
          set_name: "Pack",
        },
      }),
    );
    expect(detected?.kind).toBe("sticker");
    expect(detected?.fileId).toBe("stk");
    expect(detected?.visionHint).toContain("😀");
    expect(detected?.visionHint).toContain("Pack");
  });

  it("uses the thumbnail for an animated/video sticker", () => {
    const detected = detectMessageMedia(
      msg({
        sticker: {
          file_id: "anim",
          file_unique_id: "u",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          thumbnail: { file_id: "thumb", file_unique_id: "t", width: 128, height: 128 },
        },
      }),
    );
    expect(detected?.fileId).toBe("thumb");
  });

  it("reads an image document", () => {
    const detected = detectMessageMedia(
      msg({ document: { file_id: "doc", file_unique_id: "d", mime_type: "image/png" } }),
    );
    expect(detected).toEqual({
      kind: "image_document",
      fileId: "doc",
      fileUniqueId: "d",
      visionHint: null,
      isVideo: false,
      isAudio: false,
      thumbnailFileId: null,
      durationSec: null,
    });
  });

  it("samples frames from an image/gif animation (points at the real file)", () => {
    const detected = detectMessageMedia(
      msg({
        animation: {
          file_id: "gif",
          file_unique_id: "g",
          width: 320,
          height: 240,
          duration: 2,
          mime_type: "image/gif",
          thumbnail: { file_id: "gthumb", file_unique_id: "gt", width: 90, height: 60 },
        },
      }),
    );
    expect(detected).toEqual({
      kind: "animation",
      fileId: "gif",
      fileUniqueId: "g",
      visionHint: null,
      isVideo: true,
      isAudio: false,
      thumbnailFileId: "gthumb",
      durationSec: 2,
    });
  });

  it("samples frames from an mp4 video, keeping the thumbnail as a fallback", () => {
    const detected = detectMessageMedia(
      msg({
        video: {
          file_id: "vid",
          file_unique_id: "v",
          width: 1920,
          height: 1080,
          duration: 5,
          mime_type: "video/mp4",
          thumbnail: { file_id: "frame", file_unique_id: "f", width: 320, height: 180 },
        },
      }),
    );
    expect(detected).toEqual({
      kind: "video",
      fileId: "vid",
      fileUniqueId: "v",
      visionHint: null,
      isVideo: true,
      isAudio: false,
      thumbnailFileId: "frame",
      durationSec: 5,
    });
  });

  it("treats a video document (mime video/*) as frame-sampled video", () => {
    const detected = detectMessageMedia(
      msg({
        document: {
          file_id: "vdoc",
          file_unique_id: "vd",
          mime_type: "video/mp4",
          thumbnail: { file_id: "vdthumb", file_unique_id: "vdt", width: 90, height: 60 },
        },
      }),
    );
    expect(detected).toMatchObject({
      kind: "video",
      fileId: "vdoc",
      isVideo: true,
      thumbnailFileId: "vdthumb",
      durationSec: null,
    });
  });

  it("detects a voice message as audio to transcribe", () => {
    const detected = detectMessageMedia(
      msg({
        voice: { file_id: "vc", file_unique_id: "vu", duration: 7, mime_type: "audio/ogg" },
      }),
    );
    expect(detected).toEqual({
      kind: "voice",
      fileId: "vc",
      fileUniqueId: "vu",
      visionHint: null,
      isVideo: false,
      isAudio: true,
      thumbnailFileId: null,
      durationSec: 7,
    });
    expect(messageHasVisionMedia(msg({ voice: { file_id: "vc", file_unique_id: "vu", duration: 7 } }))).toBe(
      true,
    );
  });

  it("ignores a non-image document (e.g. a PDF)", () => {
    const detected = detectMessageMedia(
      msg({ document: { file_id: "pdf", file_unique_id: "p", mime_type: "application/pdf" } }),
    );
    expect(detected).toBeNull();
  });

  it("returns null for a text-only message", () => {
    expect(detectMessageMedia(msg({ text: "hello" }))).toBeNull();
    expect(messageHasVisionMedia(msg({ text: "hello" }))).toBe(false);
  });
});

describe("findReplyMediaMessage", () => {
  it("finds the first media message up the reply chain", () => {
    const image = msg({
      message_id: 10,
      photo: [{ file_id: "p", file_unique_id: "p", width: 100, height: 100 }],
    });
    const middle = msg({ message_id: 11, text: "hmm", reply_to_message: image });
    const current = msg({ message_id: 12, text: "what is this?", reply_to_message: middle });
    expect(findReplyMediaMessage(current)?.message_id).toBe(10);
  });

  it("returns null when no ancestor carries media", () => {
    const parent = msg({ message_id: 2, text: "hi" });
    const current = msg({ message_id: 3, text: "yo", reply_to_message: parent });
    expect(findReplyMediaMessage(current)).toBeNull();
  });
});
