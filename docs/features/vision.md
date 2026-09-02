# Vision

**Feature ids:** `vision`, `vision-backfill` · **Dashboard:** `/vision` ·
**SSE topic:** `vision`

The bot sees pictures. An image is described once by a model, and that description
then stands in for the image in every later turn — so past turns stay token-light
and the bytes can be dropped.

## Two paths

| Path | When | Traced? |
| --- | --- | --- |
| **Ingest** | Every incoming media message | No — passive and high-volume, like the history mirror |
| **Describe** | Immediately for the addressed turn; later, by the backfill job, for everything else | Yes — a meaningful action |

**Ingest** is split along the transport contract. The transport downloads the
file with the connection's token — only it can talk to its platform's file API —
normalizes it, and attaches the payload to the `transport.message` event as
ordered base64 `frames` plus a `visionHint` (`apps/tg/src/media/ingest.ts`,
`telegram-files.ts`, `normalize.ts`, `frames.ts`). The core's ingest stores the
row `status = 'pending'` with its bytes in `source_media_blobs`
(`server/source-store/media.ts`). A payload that could not be loaded travels as
an `unavailable` marker, recorded once and never re-attempted — and the turn
still runs on the text. A web-chat upload takes the in-process route: the
web-chat service normalizes it and stores it as pending `web_media`.

**Describe**: caption the stored image with a context-free describe pass, store the
description on the media row, mark it `described`, and — for a transport's media —
**drop the bytes**: the platform is its own archive. A described row never comes
back around. Web-chat media keeps its bytes after describing, because a web
thread is the only archive its pictures have
(`features/web-chat/server/media-repository.ts`).

Recognition of the current message's media happens *before* the reply, but only for
an addressed message that also carries text. A media-only message is answered in
one pass and its media — like unaddressed media — is described later by the
backfill job.

**Raw image bytes never reach a reply request** (user decision, 2026-08-15) —
the vision pass exists precisely so the reply model reads text. The current
message's media is recognized (describe + store) inside the turn and the reply
carries the recognition text; a replied-to media message resolves to its stored
description or transcript, described on the spot when still pending. A
replied-to message that was never stored reads as unavailable — the core cannot
re-download it, only the transport could. The conditional attach this replaces
400'd wholesale on a text-only chat provider (Z.ai `glm-4.7-flash`:
`messages.content.type is invalid`, trace `f37d84b9…`). The only requests that
carry images are the describe pass itself and the browser agent's own loop.

## Detection

`apps/tg/src/media/detect.ts` (pure, ported verbatim from the core's
`features/vision/detect.ts`, which stays as the unit-tested reference) decides
*what* file to read and how to hint the describer. Precedence mirrors the MVP, with
one change:

| Media | Handling |
| --- | --- |
| Photo | Decoded directly as a still image |
| Static sticker | Decoded directly; the sticker's emoji and pack name become the `vision_hint` |
| Image document | Decoded directly |
| `animation` / `video` (Telegram delivers both as mp4) | Points at the **actual media file** so frames can be sampled with ffmpeg. Telegram's single-frame thumbnail is kept as a fallback for when frame extraction is unavailable |
| Voice | Handled by the [Voice](voice.md) feature, on the same media pipeline |

## Normalization and frames

- **Normalization** (`normalizeImageForChat` — `@assistant-hub/media`, and the
  transport's `apps/tg/src/media/normalize.ts`): any image — WebP stickers,
  PNGs, oversized photos — is converted to a bounded JPEG via `sharp` (longest
  edge 768 px, under 900 KB), so OpenAI-compatible vision endpoints accept it
  reliably and the base64 stays small enough to store and send.
- **Frames**: sharp cannot decode mp4, so frames are pulled with the system
  `ffmpeg` binary (user decision: system ffmpeg over a bundled/WASM build).
  **10 frames** are always sampled **evenly across the whole clip**
  (`fps=count/duration`, the duration probed with ffprobe when the platform did
  not say), so short and long clips alike are covered end to end rather than
  just the opening seconds; the frames travel as an ordered image sequence with
  a sequence hint. The Telegram transport samples them for its own ingest path
  (`apps/tg/src/media/frames.ts`, on `apps/tg/src/media/ffmpeg.ts`). The core
  keeps its own sampler (`features/vision/server/frames.ts`, on
  `server/media/ffmpeg.ts`) behind `ingestMessageMedia` / `resolveMediaText` in
  `features/vision/server/service.ts`; nothing on the live turn path calls
  those — the turn consumer resolves media through the store port, and the
  web chat normalizes uploads without sampling.

## The describe pass

Context-free: the describe system prompt plus a single vision `user` turn carrying
the images and any hint. Ported from the MVP, and the prompt demands an
**exhaustive** plain-text description — anything omitted is lost once the bytes are
dropped. The pass reads and writes through a `MediaStorePort`
(`server/turn/source-media.ts`), so the same code captions a transport's row
and a web upload.

## The backfill job

Idle-debounced. The scheduler runs the backfill only after the bot has been quiet
for **45 seconds**; `pokeVisionBackfill()` is called on every handled message,
which re-arms the wait **and aborts a batch in flight**. Backfill therefore never
competes with a live reply for the LLM. It works across every source's media
store (`mediaSources()`): pictures arrive wherever people are.

- **Live-processing semaphore** (user decision, 2026-07-27): the ingest mirrors
  the message with `source_messages.processed = false` and the turn's settle
  releases it to `true`; `listPendingMedia` only returns media whose message is
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
| `source_media` | One row per media-bearing transport message: `source`, `chat_id`, `source_message_id`, `kind`, `file_id`, `file_unique_id`, `mime_type`, `vision_hint`, `description`, `status` (`pending` \| `described` \| `unavailable`), `described_at`. Unique on `(source, chat_id, source_message_id)`; **no foreign key** onto `source_messages` — mirror first, media second is the ingest's ordering, not a constraint. Media the bot itself authored is never ingested from an inbound update; a generated picture arrives through the transport's `message.delivered` report and is stored as pending media so the describer recognizes what the bot drew |
| `source_media_blobs` | Real `bytea`, one row per frame, **only while the row is `pending`**. The repository converts to/from base64, so callers never handle `Buffer`s |
| `web_media`, `web_media_blobs` | The web chat's: one row per message (`image` \| `voice` \| `file`), the same status lifecycle, bytes kept after describing |

## Dashboard

`/vision` is a read-only gallery across every source: a pending row shows its
stored image (awaiting description), a described row shows the model's text (a
transport row's bytes are gone; a web row still renders its picture). The
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
| The assistant's transport connection | The transport downloads with that connection's token; the core holds no bot token |

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
before. `relatedIdsKey` is `message_media` (the registry key kept its v1 name),
so a standalone trace links to the media row it captioned.

## Tests

Unit: `detect.test.ts`, `format.test.ts`, `server/describe.test.ts`.
Integration: `server/vision.integration.test.ts`,
`server/backfill.integration.test.ts`; the live paths in
`server/ingest/ingest.integration.test.ts` (event media stored and referenced on
the turn), `server/turn/turn-consumer.integration.test.ts` (a pending photo
recognized through the media store and folded into the turn), and
`features/web-chat/server/web-chat.integration.test.ts` (an upload normalized,
stored pending, and kept after describing).
