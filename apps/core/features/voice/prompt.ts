/**
 * Voice transcription prompts. The transcriber is the audio-capable chat model
 * (user decision — no separate whisper endpoint), so accuracy is governed
 * entirely by these instructions: the model must return the words alone, in the
 * language spoken, with no commentary — the transcript is stored verbatim as the
 * media row's description and read back in transcripts and replies.
 */

export const VOICE_TRANSCRIBE_SYSTEM = [
  "You are a transcription engine.",
  "Transcribe the audio exactly as spoken, in the language spoken — do not translate.",
  "Output ONLY the transcript text: no preamble, no quotes, no timestamps, no speaker labels, no commentary.",
  "Keep natural punctuation and sentence boundaries.",
  "If the audio contains no discernible speech, output exactly: [no speech]",
].join("\n");

export const VOICE_TRANSCRIBE_USER = "Transcribe this voice message.";

/** The transcriber's marker for audio with nothing spoken in it. */
export const NO_SPEECH_MARKER = "[no speech]";
