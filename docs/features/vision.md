# Vision

**Feature ids:** `vision`, `vision-backfill` · **Dashboard:** `/vision` ·
**SSE topic:** `vision` · **Priority 7 and 8**

The bot sees pictures. An image is described once by a model, and that description
then stands in for the image in every later turn — so past turns stay token-light
and the bytes can be dropped.

## Two paths

| Path | When | Traced? |
| --- | --- | --- |
| **Ingest** | Every incoming media message | No — passive and high-volume, like the history mirror |
| **Describe** | Immediately for the addressed turn; later, by the backfill job, for everything else | Yes — a meaningful action |

**Ingest**: download the file with the bot token, normalize it, store it with
`status = 'pending'` and its bytes in `media_blobs`.

**Describe**: caption the stored image with a context-free describe pass, store the
description on the `message_media` row, mark it `described`, and **drop the bytes**.
A described row never comes back around.

Recognition of the current message's media happens *before* the reply, but only for
an addressed message that also carries text. A media-only message is answered in
one pass and its media — like unaddressed media — is described later by the
backfill job.

**Raw images reach the reply request only when the chat model reads images** —
`chatModelReadsImages()`: true exactly when the vision role resolves to the
chat connection (unset, or pointed at the same endpoint + model). With vision
pointed at a separate describer, nothing says the chat model accepts image
input, and a text-only provider rejects the whole request (Z.ai
`glm-4.7-flash`: 400 `messages.content.type is invalid`, trace `f37d84b9…`,
2026-08-15). The reply then rides the recognition text already in the prompt,
and the trace's "vision media attached" step says the images were withheld and
why.

## Detection

`features/vision/detect.ts` (pure) decides *what* file to read and how to hint the
describer. Precedence mirrors the MVP, with one change:

| Media | Handling |
| --- | --- |
| Photo | Decoded directly as a still image |
| Static sticker | Decoded directly; the sticker's emoji becomes the `vision_hint` |
| Image document | Decoded directly |
| `animation` / `video` (Telegram delivers both as mp4) | Points at the **actual media file** so the server can sample frames with ffmpeg. Telegram's single-frame thumbnail is kept as a fallback for when frame extraction is unavailable |
| Voice | Handled by the [Voice](voice.md) feature, on the same media pipeline |

## Normalization and frames

- **Normalization** (`server/normalize.ts`): any Telegram image — WebP stickers,
  PNGs, oversized photos — is converted to a bounded JPEG via `sharp`, so
  OpenAI-compatible vision endpoints accept it reliably and the base64 stays small
  enough to store and send.
- **Frames** (`server/frames.ts`): sharp cannot decode mp4, so frames are pulled
  with the system `ffmpeg` binary (user decision: system ffmpeg over a
  bundled/WASM build). **10 frames** are always sampled **evenly across the whole
  clip** (`fps=count/duration`), so short and long clips alike are covered end to
  end rather than just the opening seconds. The caller sends them as an ordered
  image sequence with a sequence hint.

## The describe pass

Context-free: the describe system prompt plus a single vision `user` turn carrying
the images and any hint. Ported from the MVP, and the prompt demands an
**exhaustive** plain-text description — anything omitted is lost once the bytes are
dropped.

## The backfill job

Idle-debounced. The scheduler runs the backfill only after the bot has been quiet
for **45 seconds**; `pokeVisionBackfill()` is called on every handled message,
which re-arms the wait **and aborts a batch in flight**. Backfill therefore never
competes with a live reply for the LLM.

- **Live-processing semaphore** (user decision, 2026-07-27): the mirror row is
  written with `chat_messages.processed = false` and released to `true` in the
  pipeline's `finally`; `listPendingMedia` only returns media whose message is
  released — or whose hold is older than **10 minutes** (a crashed pipeline must
  not hide a row forever). Unlike the in-process debounce, this also stops a
  backfill in *another process sharing the DB* from racing the live pass.
- Locking: a cross-process advisory lock.
- Idempotency: per-row `status = 'pending'` gating, and `describeAndStore`
  re-checks status before spending a call — and if it still loses the write race,
  it **reuses the winner's stored text** (warn event on the trace) rather than
  reporting a failure while a description exists. Together that means a redeploy
  overlap can never double-describe a row or drop a paid-for description.
- The LLM connection is read fresh per run, so a settings change takes effect on the
  next run without a restart.
- At boot the scheduler arms an initial run, so media left `pending` from before the
  restart is captioned during the first quiet window.

## Data

| Table | Notes |
| --- | --- |
| `message_media` | `kind`, `file_id`, `mime_type`, `vision_hint`, `description`, `status` (`pending` \| `described` \| `unavailable`), `described_at`. Unique on `(chat_id, telegram_message_id)`, which is also a **FK to `chat_messages`** (user decision, 2026-07-27): media never floats free of the mirror — mirror first, ingest second, and bot-authored media is not ingested at all (the bot never answers bots) |
| `media_blobs` | Real `bytea`, one row per frame, **only while the row is `pending`**. The repository converts to/from base64, so callers never handle `Buffer`s |

## Dashboard

`/vision` is a read-only gallery: a pending row shows its stored image (awaiting
description), a described row shows the model's text (its bytes are gone). The
backfill job card sits above, with the pending count as its backlog badge.

## Trace payload exception

Vision is the one scoped exception to the "trace bodies hold complete raw payloads"
rule. `sanitizeMessagesForTrace` replaces each inline
`data:image/…;base64,<~1MB>` URL with `data:<mime>;base64,<N bytes>`. The bytes are
not lost — the real image is on the Vision page — and everything the operator reads
(roles, text, structure) stays verbatim. Storing a megabyte of base64 per image
would bloat the log and make the Debug JSON unreadable.

## Configuration

| Setting | Effect |
| --- | --- |
| Vision role (`visionBackendId`/`visionModel`, chat backend + model by default) | Must resolve to a vision-capable model for descriptions to work |
| `telegramBotToken` | Needed to download files from the Telegram file API |

`server/telegram-files.ts` downloads by `file_id` and is deliberately kept
independent of grammy, so the backfill can re-download without a live `Context`.

## API

`GET /api/vision/backfill` → `{ status, pending }`;
`POST /api/vision/backfill` → trigger a run and return the same shape.

## Tracing

| Feature id | Action |
| --- | --- |
| `vision` | `describe` — backfill rows only |
| `vision-backfill` | The backfill run |

A **live** turn's recognize pass records into the `bot-messaging`/`reply` trace
instead of opening its own (user decision, 2026-07-27): receive → describe →
reply is one flow, one trace. `describeAndStore` takes the reply trace as an
optional parent; without one (backfill) it opens and settles its own trace as
before. `relatedIdsKey` is `message_media`, so a standalone trace links to the
media row it captioned.

## Tests

Unit: `detect.test.ts`, `format.test.ts`, `server/describe.test.ts`.
Integration: `server/vision.integration.test.ts`,
`server/backfill.integration.test.ts`.
