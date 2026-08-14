# Voice

**Feature id:** `voice` · **Trace actions:** `transcribe`, `synthesize` ·
**Dashboard:** `/vision` · **SSE topic:** `vision` · **Priority 14** (added by the
user, 2026-07-23)

Both directions of speech: the bot hears voice messages, and — when a speech
endpoint is configured — answers with one.

Voice rides the vision media pipeline (`message_media`, `kind = 'voice'`).

## Hearing: voice → text

1. A `voice` message is detected by the shared media detector.
2. It is transcribed **eagerly** — before the reply flow starts, with its own typing
   loop, because the transcript is what everything downstream reads.
3. The transcript becomes the message's **effective text**: addressing, the current
   turn and the reply all read the words as if they had been typed.
4. It is stored verbatim as the media row's `description`, so later transcripts and
   replies read it back like any other described media.

### One trace per voice turn (user decision, 2026-07-27)

A live voice message produces **one** trace — the `bot-messaging`/`reply` trace,
opened by the runtime *before* transcription so the transcribe request/response/db
events land at the top of the same flow the reply then continues (receive →
transcribe → addressing → context → reply). The trace's `inputSummary` is filled
with the transcript once it exists. Separate `voice`/`transcribe` traces remain
only for passes with no reply turn: the backfill job and the Settings probe.

The transcript is also handed back **in-process**, not re-read through the DB
write: if a concurrent pass described the row first, `describeAndStore` re-reads
and reuses the stored text (with a warn event saying so) instead of telling the
reply the transcription failed while a transcript exists.

Audio must be transcoded: Telegram delivers voice as OGG/Opus, which
OpenAI-compatible `input_audio` parts do not accept (the spec allows only `wav` and
`mp3`). `server/media/audio.ts` converts to **16 kHz mono WAV** — whisper-class
models' native rate and the most universally decodable container — on the shared
system-ffmpeg runner.

### Two transcription backends

| Configured | Behavior |
| --- | --- |
| `audioModel` set (audio role) | A real `/v1/audio/transcriptions` call on the audio role's backend (whisper.cpp server, speaches/faster-whisper, LocalAI…) |
| Unset | Falls back to transcribing with the **audio-capable chat model** |

On the chat-model path, accuracy is governed entirely by the prompt
(`features/voice/prompt.ts`): the model must return the words alone, in the language
spoken, with no commentary. The transcript is stored verbatim, so any commentary
would end up in the history mirror as if it had been said.

The Settings probe for the audio role transcribes a fraction of a second of
generated silence rather than checking `/v1/models`, because whisper-class servers
often serve the transcription route without a model listing.

### Silence is an answer; nothing is a failure

`readTranscript` (`features/voice/format.ts`) classifies what came back into
three outcomes, and the difference between the last two is the whole point:

| Outcome | Meaning | Stored as |
| --- | --- | --- |
| `text` | Speech was transcribed | The transcript, verbatim |
| `no-speech` | The transcriber listened and reported the `[no speech]` marker — a terminal fact about the audio | `(no speech)`, row `described` |
| `empty` | Nothing came back at all — a fact about the *call* | Nothing; the transcribe fails, the row stays `pending` |

An endpoint that answers `200` with an empty body has failed, however it dressed
the response up. Storing that would mark the row `described`, drop the audio
bytes, and make the failure both permanent and invisible — the operator sees a
"Transcribed" card with no content and no pass ever retries it. So an `empty`
outcome throws: the trace records an error, the audio survives, and the backfill
picks the row up again. Only `no-speech` is terminal, because re-transcribing a
genuinely silent recording would loop forever.

For the same reason `TranscriptionResult.text` (`server/llm/transcription.ts`)
is the endpoint's own text, trimmed and otherwise unclassified, in **both**
modes — a lower layer collapsing the marker to an empty string would destroy the
distinction before anyone could ask for it.

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
| `speechBackendId` | Uses the chat backend |
| `speechModel` | **Voice replies are off** |
| `speechVoice` | The endpoint's default voice |
| `audioBackendId` | Uses the chat backend |
| `audioModel` | Falls back to the audio-capable chat model |

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
