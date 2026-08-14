# Browser agent

**Feature ids:** `browser-agent`, `mcp-tools-browser-agent` ·
**Dashboard:** `/browser` · **SSE topic:** `browser` · **Priority 13**

A sub-agent that drives a **real browser** to accomplish a goal: search, navigate,
click, type, scroll, read, inspect network traffic, screenshot, download. It runs in
the background and reports back to the chat when done.

This is the bot's **only** web-facing tool (user decision, 2026-07-26). The earlier
`search_web` (Tavily snippets) and `read_web_page` (one-shot page read) MCP tools are
**gone**: a real browser does both jobs better, and offering the model two weaker
alternatives only split its choice — every phrasing became a fight over which tool
should win. Searching now happens *inside* a run, on live search engines, with the
Tavily API kept as a last-resort fallback there.

## Two layers, deliberately separated

| Layer | What the main chat model sees |
| --- | --- |
| `browse_web` (MCP tool) | One dispatch tool. Enqueue a goal, get an ack, move on |
| The generic browser toolset | **Nothing.** These are plain OpenAI tool definitions for the agent's own loop and are never offered to the chat model |

The chat model does **not** drive the browser itself (recorded decision: background
run, not inline). A browsing session is many rounds of latency; holding a Telegram
turn open for it would stall the chat.

## `browse_web`

Input: `goal` — 4–4000 chars, "a clear, self-contained description of what to find
or do on the web. Include ALL links the user gave."
Output: `{ ok, runId? }`.

The description is unusually forceful, and for a documented reason: models
persistently refuse this class of request. It explicitly says that replying "I'm just
a language model" or "I cannot download files" is **wrong** when a user asks to
download or save something, because this is exactly the tool for it. It lists the MUST-call cases:

1. The user asks you to look something up or check what is online right now.
2. The user shares a URL, or asks about the content of a page whose URL is in the
   conversation — read that page instead of answering from memory.
3. The user asks to download or save a file, video, image or document.
4. The user names a specific site, service or page to get data **from**.
5. The user wants a **live or current** value — weather, a price, a rate, live stats,
   a viewer count, a dashboard, availability, today's news.
6. The task needs multi-step interaction on the web.

It also requires the goal to **keep the user's request intact** (user report,
2026-07-29). Asked only "«link» download track", the chat model composed the goal
*"Navigate to «link» to identify the track and find a way to download it **or provide
direct info about what it is**"* — inventing an easier alternative the user never
offered. The sub-agent then took it: it reported what the track was and stopped. A
weaker branch in the goal is read as permission to stop early, so the description now
forbids adding one ("or describe it", "or explain how to get it") and asks the model
to say whether audio or video is wanted.

And the one DO-NOT: casual chat, an opinion, or a stable fact the model already knows
well and was not asked to verify. Since there is no cheaper web tool left, the
description no longer has to argue about when to prefer a plain search — the earlier
carve-outs for "a commodity live value" and "a general lookup" are gone, and those
requests now browse too.

Anyone may start a run. The **download tools inside the run** are gated to runs
carrying the owner's rights, resolved at enqueue time — not at call time, and not
from anything the model says. Those rights are either the sender's own or lent by
a standing chat rule ("rule creator beats message source"). A run is marked
**`restricted`** when a rule drove it in a group chat — the owner's own message
included — or when the rule lent the sender rights they did not hold; only the
owner's direct requests, their own DM rules, and dashboard runs stay
unrestricted. A restricted run is fenced two ways (user decisions, 2026-08-01,
after a rule-driven run downloaded an unrelated music video and stranded it on
the server's disk):

- **URL fence.** The triggering message's URLs are extracted **in code**
  (`urls.ts`) and stored on the run as `source_urls`; a restricted run's download
  tools accept only those URLs or same-site ones (subdomains fold to the
  registrable domain; `youtu.be`/`youtube.com` and `x.com`/`twitter.com` are
  aliases). Anything else is refused with an instruction to report the failure —
  substitute downloads are impossible in code, whatever the model decides. The
  same verbatim list is appended to the agent's goal message, because the goal
  text is composed by an LLM that has mis-typed a URL before (a flipped digit in
  a 19-digit tweet id). Deliberate limitation: a direct-file/stream download from
  a CDN host other than the message's site is also refused on a restricted run —
  the rule use-case is media pages, where `browser_download_media` takes the page
  URL itself.
- **Attach or fail.** A file the chat cannot take (over Telegram's 50 MB bot
  upload ceiling) is deleted, recorded with `discarded: true`, and reported as a
  failed delivery — the requester cannot reach the server's downloads folder, so
  keeping the file would strand it. The run's report is then sent without a
  notification ping. Owner-started runs keep the old behavior (file stays on
  disk, announced by name).

## The agent

`server/agent.ts`: one goal, run to completion in one session, driven by the
configured chat model over the shared tool loop.

Deliberately **unbounded** (recorded decision): no round cap, no wall-clock cap. Only
the loop's stall guard ends a run that stops progressing — three rounds that each
introduce no new tool call — and its forced tools-free final round then salvages a
report from whatever was gathered.

For an owner-started run the system prompt also carries two download rules, stated
there as well as in the tool descriptions because the failure they address is a
*decision the agent makes before it ever looks at a tool*: a goal that asks for a file
is not done until a download tool has been called, and finishing by telling the user
to download it themselves (or naming a program for them to run) is forbidden — either
the file, or exactly which tool was called and how it failed. The second rule points
media-site pages at `browser_download_media` and tells the agent not to go hunting for
a media URL that does not exist. A third rule (2026-08-01) forbids substitute
downloads outright: if the named content cannot be downloaded, the run has failed and
must say so — never fetch "similar" content instead, even when the goal text seems to
offer that option.

### The toolset

Generic primitives only. Recorded decision: **no scenario-specific tools** — the
model composes primitives rather than the code encoding any one task. Finding "the
video" is the model's job: it reads the page or the network, picks the URL, and calls
the matching download tool. There is no media-sniffing heuristic baked in.

| Tool | Purpose |
| --- | --- |
| `browser_search` | Find pages: top 5 results (title + URL + snippet) to choose from (see below) |
| `browser_navigate`, `browser_back` | Movement |
| `browser_click`, `browser_type`, `browser_scroll` | Interaction, by element ref |
| `browser_read`, `browser_source` | Readable text / raw source |
| `browser_get_network` | Inspect the requests the page made — how a stream URL is found |
| `browser_screenshot` | Capture (stored in Postgres) |
| `browser_wait` | Let a page settle |
| `browser_download_file` | Stream a direct URL to disk (plain HTTP) |
| `browser_download_stream` | Mux an HLS/DASH **manifest** into a single MP4 with ffmpeg |
| `browser_download_media` | Extract the audio or video of a media **page** with yt-dlp |

Three download tools rather than one because the three cases take genuinely
different inputs: a whole-file URL, a manifest URL, and the page URL itself.

### Search — the engine cascade

`server/search.ts`. `browser_search` is where a run starts when the goal carries no
URL (the agent's system prompt says so explicitly, and forbids guessing a URL it was
not given). Whatever answers, the agent gets the **same thing**: a numbered list of
the top 5 results — title, URL, snippet — and it decides which to open, one or
several or all. That uniformity is the point: an engine's live page and the API
fallback used to hand the agent two different-shaped things, so its next move
depended on which source happened to work.

Sources, in their *configured* order:

1. **DuckDuckGo** — `duckduckgo.com/?q=`
2. **Google** — `google.com/search?q=`
3. **Bing** — `bing.com/search?q=`
4. **Tavily API** — last resort only, via `features/web-search`

That order is only the starting point. The engines are re-sorted per search by
their measured success rate — see [the scoreboard](#the-scoreboard) — so whichever
one is really answering drifts to the front. Tavily is not ranked: it is the
fallback by definition and always runs last.

#### What the engines actually do (measured 2026-07-26)

From this repo's own headless Chromium, via `search-live.integration.test.ts`:

| Engine | Result |
| --- | --- |
| DuckDuckGo | Serves a page whose results **never render** — its SPA returns a shell. The `html.` and `lite.` endpoints are refused outright. With a *browser* user-agent instead of the bot one it is worse: a hard `418` block page |
| Google | **Captcha** (`/sorry/index`), every time |
| Bing | **Works** — a real results page, 5/5 relevant, extracted cleanly |

So today Bing is the engine that answers. The configured order tries the two blocked
engines first, but the scoreboard fixes that by itself: after the first search
Bing outranks them and every later search goes to it directly. Two findings worth
carrying: the honest bot user-agent is **not** the problem (swapping it
for a Chrome string made DuckDuckGo block harder), and a blocked engine sometimes
serves a **plausible-looking decoy** — Bing once returned Russian Wikipedia pages
about toucans for a printing-press query — which is why the live test asserts the
results are *relevant*, not merely present.

#### The scoreboard

`server/engine-stats.ts` + the `search_engine_stats` table: one row per source with
`successes`, `failures`, the last success/failure timestamps, and the last failure's
reason. Every attempt writes its outcome, including Tavily's — so the table also
answers "how often does the fallback get used, and does it work?".

The cascade sorts the engines by a **smoothed** success rate,
`(successes + 1) / (attempts + 2)`, not the raw ratio. That choice does two things
that matter on real data:

- an engine with **no history scores 0.5**, so it is tried in its configured
  position and gets a real chance to prove itself — a newly added engine is not
  buried behind a known-bad one;
- **one lucky hit cannot outrank a long record** — 1/1 scores 0.67 while 40/42
  scores 0.93.

Ties keep the configured order, so the ranking only ever *reacts* to evidence, and
a cold install runs exactly the configured order.

Counters are **halved once a source passes 100 attempts**, in the same statement
that increments them (so two concurrent runs cannot race). Without decay a long
history freezes the ranking: an engine that starts blocking would keep its good
score for hundreds of searches, and one that recovers could never climb back. With
it, the score tracks roughly the last hundred searches — the ranking reacts within
a few searches, in both directions.

Losing a scoreboard write never fails a search: `recordEngineOutcome` swallows and
logs its own errors, and an unreadable scoreboard falls back to the configured
order.

#### How results are recognized

Structurally, never by what the page says (`no-linguistic-heuristics-in-code`). Three
filters, each earned from a real engine's behaviour:

1. **Inside `<main>` / `role="main"`.** Off-site-ness recognizes nothing on its own:
   DuckDuckGo's promos (its apps in the App Store and Play Store, its blog) are
   off-site, described, repeated, and sit *above* where results would be — the first
   version of this shipped them as search results. A results page marks its results
   as the document's main region; a shell or a consent wall has none, which is
   exactly the "no results" answer the cascade needs to move on.
2. **The repeated block.** Within main, links are bucketed by a structural signature
   (the tag+class chain of their ancestors, `PageLink.group`). Results come from a
   template and repeat; stray controls do not. The bucket with the most *described*
   members wins, size breaking the tie. Class names never have to mean anything or
   stay stable between pages — only to repeat within one page.
3. **One entry per destination.** Engines link the same result twice: the headline
   and the citation line above it. They merge, keeping the title that is not a URL
   and the longer snippet, and the citation is stripped out of the snippet using the
   result's own host.

Redirect wrappers are unwrapped mechanically — Google's `/url?q=`, DuckDuckGo's
`/l/?uddg=`, Bing's base64 `/ck/a?u=` — accepting a candidate only if it parses as an
http(s) URL. Without this, Bing's results all look like `bing.com` links and get
dropped as navigation.

An engine yielding fewer than 3 results is written off, and gets exactly **one**
second chance first (wait 3s, re-read), because both ways a first read can miss are
timing rather than a verdict: results that paint client-side, and an interstitial
redirect that destroys the page mid-read ("Execution context was destroyed").

The Tavily fallback maps its rows into the same shape. If it is unconfigured or empty
too, the tool returns an error result naming every attempt and telling the agent not
to invent results — visible in the run's activity feed and its trace, never silent.

### Snapshots and refs

Every action resolves to a fresh `PageSnapshot`: the readable text of the current page
plus a numbered list of its interactive elements. The agent acts **by ref** — "click
[12]", "type into [3]" — and because every action returns a new snapshot, refs always
match the live DOM.

`snapshot.ts` is pure: the in-page script is built here as a string and evaluated by
the server session, so formatting and the script builder are unit-testable without a
browser.

### The session

`server/session.ts`: one guarded browser context per run — SSRF routing plus adblock,
on the **shared Chromium singleton** (recorded decision: the browser outlives the
session, the context never does) — holding one page the agent drives. Created per run
and closed when the run settles.

## The runner

`server/runner.ts` is an in-process queue pump, the same operating model as the
tasks poller. A single run executes at a time; the queue **is** the
`browser_agent_runs` table.

- Enqueuers insert a `queued` row and then call `emitRunEnqueued()` (`signal.ts`, a
  `globalThis` singleton), so a new run is picked up immediately rather than waiting
  for a poll.
- At boot, a crash-safety sweep fails any run left `running` by a previous process.
- A run with no LLM configured settles as a **failure** rather than hanging.

### Delivery

One combined message wherever possible (user decision, 2026-08-01 — the earlier
file-then-recap flow repeated the same filename twice and spammed the chat):

- An attachable download — within Telegram's fixed 50 MB bot upload ceiling
  (`TELEGRAM_MAX_UPLOAD_MB`; user decision, 2026-08-01, replacing the old
  `browser_download_max_mb` setting) — is **staged**: the runner holds it and
  delivers it at the end of the run **together with the final report as its
  caption**, so the chat gets one message carrying both the file and what the
  agent has to say. On an owner-started run, files over the limit are announced
  (silently, by name) the moment they land.
- Files are sent **as the media they are**: an MP4/QuickTime video goes out via
  `sendVideo` (playable straight in Telegram, streaming enabled), an MP3/M4A via
  `sendAudio` (music player), anything else as a document. A container Telegram
  rejects as media falls back to a document send. Captions render like any bot
  message (HTML with a plain-text fallback).
- The combined form needs one staged file and a report that fits Telegram's
  1024-character caption cap. Otherwise each staged file goes out under its own
  filename line and the report follows as text. The report's recap section lists
  **only files that did not reach the chat** — a delivered attachment speaks for
  itself.
- A run that fails after downloading still delivers its staged files before the
  failure notice — a downloaded file is never lost to a later error.
- **The server copy is kept only when the chat did not get the file** (user decision,
  2026-07-29). A file the user already holds does not also need to sit on the server
  filling the disk, so a successful send is followed by an unlink. Three things leave
  a file behind, and the `deliveredToChat` flag on the run's download record is the
  single answer to which happened:

  | Outcome | `deliveredToChat` | On disk |
  | --- | --- | --- |
  | Delivered to the chat (with the report, or under its own line) | `true` | removed |
  | Over 50 MB, owner-started run — announced by name only | `false` | kept |
  | Over 50 MB, restricted run (rule-driven in a group, or rights lent to a non-owner) — **discarded** (`discarded: true`); the report says the file was too large to deliver and is sent without a ping | `false` | removed |
  | Send failed | `false` | kept |
  | Dashboard-started run (no chat exists) | `false` | kept |

  A staged file's disk copy survives until the send actually succeeds — a crash or
  failed send leaves it in the downloads folder, never nowhere. A failed unlink is
  logged and changes nothing else: the chat has the file, so the
  record stays truthful and only disk hygiene suffers. The tool result wording follows
  the same split, so the model never offers the user a folder path for a file it
  already sent. That folder (`data/downloads`, bind-mounted to the host under
  Compose) is now, more strictly than before,
  the **only** copy of whatever is in it — which is why it is a mounted directory
  rather than a container path.

  The flag replaced an older `inline` one, which recorded whether a file was *small
  enough* to attach — a different question, and one that made a dashboard run's
  downloads read as "attached to chat" when nothing had been sent anywhere. Runs
  recorded before the change have no `deliveredToChat` and normalize to `false`,
  which is accurate for them: back then every download stayed on disk.
- The report-bearing message (combined or text) is mirrored into history.
- The chat model's own "on it" reply — sent when `browse_web` enqueues the run —
  is treated as a **transient acknowledgement** (user decision, 2026-08-01): it is
  delivered silently (no notification ping; the run's report is the notification)
  and **deleted from the chat once the run settles**, its history-mirror row
  soft-deleted with it. A run that finishes before the acknowledgement is even
  delivered deletes it on arrival. The tracking is in-memory (`server/ack.ts`,
  the same `globalThis` pattern as the enqueue signal); a restart mid-run merely
  leaves one acknowledgement standing.
- A **dashboard-started run has no `chatId`** and delivers nothing; its report is
  stored on the run row and read on the page.

### The size limit

A separate cap protects the disk: `settings.browser_download_limit_gb` (1–100,
default **10**), one number for all three download tools. It is a disk guard, never a
quality choice — the stream and media tools always take the best available rendition.

One setting, three enforcement mechanisms, because the tools can't fail the same way:

| Tool | Enforced by | On hitting the cap |
| --- | --- | --- |
| `browser_download_file` | byte count in the write stream | aborts, **deletes** the partial, throws — an arbitrary HTTP body cut in half is not a smaller version of itself |
| `browser_download_stream` | ffmpeg `-fs` | stops muxing and **keeps** the partial; it is a valid, playable MP4, so the run counts it as success |
| `browser_download_media` | yt-dlp `--max-filesize` | refuses **before** downloading, from the format's declared size, so nothing is written |

Before 2026-07-29 this was two unrelated constants — 2 GB for files, 4 GB for streams —
with no recorded reason for the difference, and the 4 GB one was undocumented. A third
tool would have made it a third arbitrary number, so the operator made it a setting.

### Stream downloads

`stream-download.ts` handles the HLS/DASH case. `hls.ts` (pure, unit-tested against
real playlists) parses a master playlist and picks the best-quality video variant plus
its demuxed audio when the master carries audio separately — so a downloaded stream
is not ffmpeg's default lowest rung and does not lose its soundtrack.

SSRF: ffmpeg's own redirects are out of our hands, so the **manifest** is checked and
only public hosts are handed to ffmpeg.

### Media downloads (yt-dlp)

`media-download.ts` + the pure `ytdlp.ts`. `browser_download_media` takes the **page
URL a human would open** — a YouTube / YouTube Music / SoundCloud / Vimeo / TikTok /
Bandcamp watch or track page — and hands it to yt-dlp.

It exists because the other two tools cannot reach that content *at all*: those
players derive ciphered, per-session, per-format stream URLs in their own
JavaScript, so there is no file to GET and no manifest to mux. Reading the page
source or the network requests finds nothing downloadable — which is exactly how the
2026-07-28 YouTube Music run ended with the agent telling the owner to run yt-dlp
themselves (user decision, 2026-07-29: add the tool).

- **`mode`** — `audio` takes the best audio-only rendition and transcodes it to
  **mp3** at yt-dlp's highest VBR setting (`--audio-quality 0`). Keeping the native
  container would avoid a lossy-to-lossy re-encode, and that is what shipped first —
  but YouTube's best audio is usually opus, and **Telegram will not play an `.opus`
  document**, so the first real run produced a file nobody could listen to (user
  decision, 2026-07-29: mp3). An unplayable file's quality does not matter.
  `video` takes best video + best audio and merges, mp4 preferred, falling back to a
  container that can hold the chosen codecs. Default `video`. There is **no quality
  ceiling** on either (user decision, 2026-07-29) — only the disk guard below.
- **Naming** comes from the media's own title, not the page title the other tools
  use: `VIRUS (Fytch Remix).m4a`, not `VIRUS (Fytch Remix) - YouTube.mp4`.
- **`--no-playlist`** matters: a YouTube Music watch URL usually carries a playlist
  id, and without it one track becomes the whole radio queue.
- **`--ignore-config --no-cache-dir`** keep the run hermetic — no stray config file
  changing behaviour, and no write to a home directory the container's non-root user
  may not have.
- yt-dlp writes into a scratch directory *inside* the downloads folder, and the
  finished file is renamed into place. Inside, because that rename must not cross a
  filesystem — under Compose the downloads folder is a bind mount.
- The kept file is the largest non-`.part`/`.ytdl` file in the scratch directory, and
  a non-zero exit with a good file still counts (yt-dlp exits non-zero on
  post-processing complaints).
- **SSRF:** the page URL is checked like every server-side fetch; yt-dlp then follows
  the site's own CDN URLs, the same accepted limit ffmpeg has above.
- A missing binary is reported as an operator-fixable environment fact
  (`YtDlpMissingError`), mirroring `FfmpegMissingError`; any other failure carries
  yt-dlp's own `ERROR:` line (private video, sign-in wall, region block) so the agent
  reports the real reason instead of improvising one.

`ytdlp.ts` is pure — argv, progress lines, error text — so the whole contract with the
binary is unit-tested without it installed.

## Live state

`server/live-state.ts` holds what a running run is doing *right now* and its download
progress. Deliberately **not persisted**: it changes many times a second during a
download, and a run that dies mid-flight is swept to `failed` anyway, so durability
buys nothing. The runner writes it; the run-detail API reads it (same process).

## Data

| Table | Notes |
| --- | --- |
| `browser_agent_runs` | The queue and the record. `status`, `goal`, `report`, `error`, `steps`, `activity` (jsonb step feed), `downloads` (jsonb), `is_owner`, `restricted`, `source_urls`, `trace_id` |
| `browser_run_screenshots` | JPEG `bytea` keyed `(run_id, seq)`, served by an auth-gated route — never in trace JSON |

## Dashboard

`/browser` lists runs and lets the operator start one directly. The run view shows the
goal, status, the activity feed (tool, action, outcome per step), the download list,
the screenshots, live progress while running, and the final report. Live-updates on
the `browser` topic.

The **start-a-run form** exists so the operator can exercise or drive the agent
directly, mirroring the conversational tool without needing Telegram.

## API

`GET /api/browser` (list), `POST /api/browser` (enqueue a dashboard run, 201),
`GET /api/browser/{id}` (detail with screenshot sequence numbers and live state),
`GET /api/browser/{id}/screenshot/{seq}` (JPEG bytes).

## Configuration

| Setting | Effect |
| --- | --- |
| Browser role (`browserBackendId`/`browserModel`, chat backend + model by default) | Without a resolvable connection a run settles as a failure |
| `ownerUserId` | Only runs with the owner's rights (their own, or lent by a standing rule) may download |
| `browserDownloadLimitGb` | Hard ceiling on any single download (1–100, default 10) |

The chat-attach ceiling is fixed at 50 MB — Telegram's bot upload limit
(`TELEGRAM_MAX_UPLOAD_MB`), not a setting.

Needs a working Chromium, ffmpeg and yt-dlp. Chromium and ffmpeg come from `apk`;
yt-dlp does not (see below). Locally they must be on `PATH`; without yt-dlp,
`browser_download_media` reports that it is not installed and the run continues.

## Keeping yt-dlp current

yt-dlp is the one dependency that cannot be pinned at build time and forgotten. It
extracts from sites that change on purpose, and a build a few months old does not
degrade — it fails **every** media page at once, silently, until a user's request
fails. Alpine's package is frozen per release (four months behind upstream when this
was written), so "rebuild against a newer base image" was never a reliable fix.

So the binary tracks upstream on its own schedule (user decision, 2026-08-01):

| Layer | What it is |
| --- | --- |
| Image floor | The Dockerfile pins upstream's self-contained `musllinux` build by version + SHA-256. No python3 in the image at all — it is a PyInstaller bundle |
| Daily job | `ytdlp-scheduler.ts`, on the shared daily-job model, at the same run time as every other daily job. Checks GitHub's latest release and installs it into `data/bin` when it is newer |
| Boot check | A container with no self-updated copy yet checks immediately instead of waiting for the night, since `data/bin` is not persisted across container recreation |
| Resolution | `resolveYtDlpCommand()` prefers `data/bin/yt-dlp` over `PATH`, resolved **per download** so an update lands without a restart |

The update is written to a pid-scoped temp file, hashed against the release's
`SHA2-256SUMS`, **run once**, and only then renamed over the live path. That order is
the point: a mismatched checksum or a build that will not start (the wrong libc)
leaves the working binary exactly where it was. Everything that is merely a dead end
— an unsupported platform, an already-current binary, GitHub unreachable or
rate-limiting — settles as a no-op summary rather than a failure, because the
previous binary keeps working and the next run tries again.

The trust model, and why there is no signature check, is in
`docs/architecture/security.md`.

The version in use and where it came from (`data/bin` vs `PATH`) are on the job card
on this feature's page and on the Jobs board, with **Run now** for an immediate
check. Runs are traced under the `ytdlp-updater` feature.

## Download storage health

`getDownloadStorageHealth()` probes the real write path — `mkdir -p`, create a
pid-scoped file, remove it — mirroring the trace store's probe. Not an
`access(W_OK)` guess: a Docker bind mount the container user cannot write to satisfies
that and still fails every download. It creates the directory when missing, so
"not writable" means genuinely not writable.

Reported in four places, because a download failure is otherwise only discovered by
whoever asked for a file:

| Surface | Form |
| --- | --- |
| Overview | A **Downloads** status card (warning tone, not error) |
| `/browser` | A warning banner above the runs list |
| `GET /api/health` | `checks.downloadStorage` — informational, never a readiness gate |
| Server log | One line at boot, from the runner's start |

Deliberately **not** on the global `SystemAlerts` banner: that surface is reserved for
failures that silently destroy data, and this one destroys nothing silently — the
download throws, the tool reports it, and the failure lands on the run's activity feed
with the OS error as its summary. Keeping the banner rare is what keeps it loud.

## Tracing

Tracing lives in the **runner**, where the work happens — enqueuing is a plain insert.
Feature `browser-agent`, `relatedIdsKey` `browser_agent_runs`, and the run row carries
the `trace_id` for drill-down. The `browse_web` dispatch call is separately traced
under `mcp-tools-browser-agent`.

## Tests

Unit: `files.test.ts`, `format.test.ts`, `hls.test.ts`, `snapshot.test.ts`,
`ytdlp.test.ts` (the yt-dlp argv/progress/error contract, no binary needed),
`ytdlp-release.test.ts` (asset selection, checksum/version parsing, ordering),
`server/tools.test.ts` (the media tool's owner gate and mode default),
`server/media-download.test.ts` (the spawn plumbing, against a **stub** `yt-dlp`
placed on `PATH` — no network),
`server/ytdlp-binary.test.ts` (the updater, against a stubbed `fetch` and stub
binaries on disk — including the two cases that must *not* replace a working
binary: a checksum mismatch and a downloaded build that will not run).
Integration (live, and marked as such): `server/browse-live.integration.test.ts`,
`server/browser-agent.integration.test.ts`,
`server/primitives-live.integration.test.ts`,
`server/tool-selection.integration.test.ts`.
