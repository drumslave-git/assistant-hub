import { describe, expect, it } from "vitest";

import { buildTranscribeMessages, readTranscript, toAudioPart } from "./format";
import { NO_SPEECH_MARKER, VOICE_TRANSCRIBE_SYSTEM } from "./prompt";

describe("toAudioPart", () => {
  it("builds an input_audio content part carrying the base64 and format", () => {
    expect(toAudioPart("QUJD", "wav")).toEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });
  });
});

describe("buildTranscribeMessages", () => {
  it("pairs the strict transcribe system prompt with one audio user turn", () => {
    const messages = buildTranscribeMessages("QUJD", "wav");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: VOICE_TRANSCRIBE_SYSTEM });
    const content = messages[1].content as { type: string }[];
    expect(messages[1].role).toBe("user");
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });
  });
});

describe("readTranscript", () => {
  it("trims the model output", () => {
    expect(readTranscript("  hello there \n")).toEqual({ kind: "text", text: "hello there" });
  });

  it("reports the no-speech marker as an answer, not as emptiness (case-insensitive)", () => {
    expect(readTranscript(NO_SPEECH_MARKER)).toEqual({ kind: "no-speech" });
    expect(readTranscript("[No Speech]")).toEqual({ kind: "no-speech" });
  });

  it("separates nothing-came-back from an explicit no-speech answer", () => {
    expect(readTranscript("")).toEqual({ kind: "empty" });
    expect(readTranscript("   \n\t ")).toEqual({ kind: "empty" });
  });

  it("keeps a transcript that merely contains the marker words", () => {
    expect(readTranscript("he said no speech today")).toEqual({
      kind: "text",
      text: "he said no speech today",
    });
  });
});
