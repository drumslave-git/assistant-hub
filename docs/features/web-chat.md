# Web chat

**Feature id:** `mcp-tools-web-chat` (the delivery tools; the surface's own
events trace as `bot-messaging`) · **Dashboard:** `/chat` · **SSE topic:**
`threads` · **Source id:** `chat`

Talk to an assistant in the dashboard itself. A core feature since the chat
app was dissolved (v2 redesign, Phase 6): the former `apps/chat` store and
endpoints are ordinary core tables and server code now, but `chat` stays a
source id — scoped refs (`chat:thread:<id>`, `chat:user:<accountId>`) keep
naming its rows on events, memory and traces, and a web turn travels the same
pipeline entrance every transport's does.

## Threads

A thread is one account talking to **one assistant, fixed at creation** — no
mid-thread switching. It is owned by the account (`web_threads.user_id`,
cascading from `accounts`); a user-role account can only start threads with
its own assistants, and a thread that is not the acting account's answers
not-found. The account **is** its web-chat identity: the roster of a thread is
its owner, labelled by display name, with the account's `aliases` and
`language` riding along as they would for any participant.

A chat starts nameless: a thread created without a name carries a placeholder
and `title_provisional = true`, and the pipeline names it after the **first
exchange** — `server/turn/name-conversation.ts`, one classifier-role call
(no persona, no history, no tools), three to six words in the conversation's
language, the first line only, bounded to the field, stored through the
source's `setChatTitle`. Renaming by hand clears the flag, and a late generated
title never overwrites a name someone chose. Best-effort by design: a thread
keeps its placeholder if anything fails, and the reply never waits on it.

Every message in a thread is addressed: there is nobody else in the room to
mean, so the verdict is `private` and the analyzer never runs. The event omits
a bot account, so the pipeline uses the assistant's own name.

## Talking

`POST /api/chat/threads/{id}/messages` stores the line first — the transcript
is the durable record, and a turn that fails to enqueue must still leave what
the person said — then composes the conversation context (the last 24 hours of
the thread, insertion order, deleted rows and the current message excluded)
and enqueues one `message.inbound` event; the answer arrives the way every
source's does, through the pipeline and back over the bus. The response carries
the turn's correlation id.

A message needs text, an image, a voice note, or some of each:

| Attachment | Stored as | Then |
| --- | --- | --- |
| An image (base64, capped at 16 MB on the route) | Normalized to a bounded JPEG and stored `pending` in `web_media` / `web_media_blobs` | The vision pass describes it inside the turn; the bytes **stay** after describing — a web thread is the only archive its pictures have — and `GET /api/chat/media/{id}` serves them to the thread view |
| A voice note (`audio/webm`, as the browser records it) | Stored raw as `kind = 'voice'` | Transcribed by the core exactly as a Telegram voice message is; the turn answers the words |

Media that cannot be stored does not lose the message — the turn runs on the
text.

## Delivery and the turn's progress

There is no platform to hand a reply to: "delivering" to a web thread is
storing the line and pinging the dashboard. `server/delivery.ts` consumes the
pipeline's `reply.delivery` events for `chat` in-process (wired in
`server/source/events-consumer.ts`), appends the assistant row, and records
the delivery as a `bot-messaging` / `deliver` trace on the turn's correlation —
the same record the Telegram transport writes for its sends. A reply for a
thread that was deleted while the turn ran is dropped, and the trace says so.

The `turn.lifecycle` events are this source's typing indicator
(`server/turns.ts`): `accepted` → "Thinking…", `progress` → "Working — <tool>…",
`settled` clears it. The state is per running turn, in this process's memory
(a `globalThis` singleton, like every cross-bundle state), expires on its own
after 10 minutes so a turn that never settles cannot leave a thread thinking
forever, and every change pings the `threads` topic so the browser re-reads.

Everything else the pipeline sends beyond plain text goes through the web
chat's **outbound port** (`server/outbound.ts`, the same shape as a
transport's internal API so every caller stays one client): a voice reply is
stored as an assistant message whose text is the spoken words, with the audio
attached (`asVoice` is always true — a browser plays whatever it is given);
generated images become one message per picture with pending media, so the
vision pass describes what the assistant itself put in the thread; a
browser-run download is kept as `file` media with its caption as the message;
`deleteMessage` soft-deletes (a retracted browsing acknowledgement keeps its
row so ids never dangle); `setChatTitle` names the thread.

## Tools

The delivery tools are in-process registry tools, under the `chat_`-prefixed
names their connection era gave them (task instructions and traces that name
them keep meaning the same call):

| Tool | Offered on |
| --- | --- |
| `chat_reply_to_message` | A web-chat turn a `message` task opened (`deliveryKind = reply`) |
| `chat_send_message` | A web-chat timed fire (`deliveryKind = send`) |

Offered only on `chat` turns, each for its own delivery kind, through the
registry's offer predicate — and re-checked in the handler, because the filter
is what the model sees, not the boundary that holds. Both report their outcome
as `toolDeliveryResult`, so a fire counts what reached the thread. There is no
reaction tool, and that is the whole answer to "what does a source do about an
affordance it lacks": it does not offer the tool. Calls trace under
`mcp-tools-web-chat`.

## The page

`/chat` is the thread list with a blank conversation; `/chat/<id>` one thread
(`components/chat/ThreadsPage.tsx`, routing within itself). New threads pick
an assistant from the account's own; a thread renames inline, deletes with a
confirm, shows each line's image or audio, and re-reads on every `threads`
event. Available to every role — the web chat is each account's surface, not
an admin tool.

## Data

| Table | Notes |
| --- | --- |
| `web_threads` | `user_id` (the account, cascades), `assistant_id` (fixed; a plain column), `name`, `title_provisional`, `notes`, `language` |
| `web_messages` | The transcript: `role`, `content`, `sent_at`, `reply_to_message_id`, `deleted_at` (soft delete) |
| `web_media` | One row per message: `kind` (`image` \| `voice` \| `file`), `mime_type`, `description`, `status` |
| `web_media_blobs` | The bytes, one row per frame — kept after describing |

Operators curate a thread's `notes` and `language`, and a web user's aliases and
language, on the aggregated Users and Groups pages: `server/directory.ts` is
the `chat` entry of the directory contract, a thread being this source's
conversation (always `direct`, roster of one).

## API

| Route | Purpose |
| --- | --- |
| `GET|POST /api/chat/threads` | The account's threads / start one (`assistantId`, optional `name`) |
| `GET|PATCH|DELETE /api/chat/threads/{id}` | Transcript + running turn / rename / delete |
| `POST /api/chat/threads/{id}/messages` | Say something |
| `GET /api/chat/media/{id}` | An attachment's bytes |

All `account`-level, scoped to the session's own account.

## Tracing

The web chat writes no feature of its own beyond the tools: a turn's reply
traces as `bot-messaging` / `reply` with trigger kind `chat`, its delivery as
`bot-messaging` / `deliver`, the naming as `bot-messaging` /
`name-conversation`, and a voice reply's synthesis as `voice` / `synthesize`
with the `chat` trigger — the way in, named honestly, because Debug filters on
it.

## Tests

`server/web-chat.integration.test.ts` (the store's shape and cascade from the
account down; threads bound to one assistant, nameless starts and naming;
posting — the enqueued turn, the window, uploads normalized and kept after
describing, an unreadable upload answered on the text, voice notes; delivery,
the outbound port, the directory client, and the delivery tools' offer rules),
`server/turns.test.ts` (the running-turn state), and
`server/turn/turn-consumer.integration.test.ts` (a web-thread turn end to end,
and naming a conversation once).
