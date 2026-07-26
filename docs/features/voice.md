# Voice

**Feature id:** `voice` · **Trace actions:** `transcribe`, `synthesize` ·
**Dashboard:** `/vision` · **SSE topic:** `vision` · **Priority 14** (added by the
user, 2026-07-23)

Both directions of speech: the bot hears voice messages, and — when a speech
endpoint is configured — answers with one.

Voice rides the vision media pipeline (`message_media`, `kind = 'voice'`) but
traces as its **own** feature, so "what did the bot hear / say" filters cleanly.

## Hearing: voice → text

1. A `voice` message is detected by the shared media detector.
2. It is transcribed **eagerly** — before the reply flow starts, with its own typing
   loop, because the transcript is what everything downstream reads.
3. The transcript becomes the message's **effective text**: addressing, the current
   turn and the reply all read the words as if they had been typed.
4. It is stored verbatim as the media row's `description`, so later transcripts and
   replies read it back like any other described media.

Audio must be transcoded: Telegram delivers voice as OGG/Opus, which
OpenAI-compatible `input_audio` parts do not accept (the spec allows only `wav` and
`mp3`). `server/media/audio.ts` converts to **16 kHz mono WAV** — whisper-class
models' native rate and the most universally decodable container — on the shared
system-ffmpeg runner.

### Two transcription backends

| Configured | Behavior |
| --- | --- |
| `transcriptionBaseUrl`/`transcriptionModel` set | A real `/v1/audio/transcriptions` call (whisper.cpp server, speaches/faster-whisper, LocalAI…) |
| Unset | Falls back to transcribing with the **audio-capable chat model** |

On the chat-model path, accuracy is governed entirely by the prompt
(`features/voice/prompt.ts`): the model must return the words alone, in the language
spoken, with no commentary. The transcript is stored verbatim, so any commentary
would end up in the history mirror as if it had been said.

The Settings probe for transcription transcribes a fraction of a second of
generated silence rather than checking `/v1/models`, because whisper-class servers
often serve the transcription route without a model listing.

## Speaking: text → voice

`features/voice/server/speak.ts`: reply text → MP3 on the configured speech
endpoint → OGG/Opus for Telegram's `sendVoice`.

The second conversion is required in the other direction: speech endpoints answer
`/v1/audio/speech` with MP3 (the one format every implementation serves), while
Telegram needs OGG/Opus for a real voice bubble rather than an audio file
attachment.

Traced as `voice`/`synthesize`, correlated with the reply trace by
`chatId:messageId`.

## Configuration

| Setting | Effect when unset |
| --- | --- |
| `speechBaseUrl` | Reuses the core LLM connection |
| `speechModel` | **Voice replies are off** |
| `speechVoice` | The endpoint's default voice |
| `transcriptionBaseUrl` | Reuses the core LLM connection |
| `transcriptionModel` | Falls back to the audio-capable chat model |

Both have their own Settings tab and probe button.

## Trace payload

Audio bytes get the same treatment as image bytes: `sanitizeMessagesForTrace`
replaces an `input_audio` payload with a compact format-and-size marker. The real
audio is in `message_media` while the row is pending.

## Data

No tables of its own. A voice message is a `message_media` row with
`kind = 'voice'`, whose `description` holds the transcript.

## Tests

Unit: `format.test.ts` (how audio becomes a model content part, how a transcript
reads in the reply turn). Integration: `server/voice.integration.test.ts`.
