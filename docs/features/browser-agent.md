# Browser agent

**Feature ids:** `browser-agent`, `mcp-tools-browser-agent` ·
**Dashboard:** `/browser` · **SSE topic:** `browser` · **Priority 13**

A sub-agent that drives a **real browser** to accomplish a goal: navigate, click,
type, scroll, read, inspect network traffic, screenshot, download. It runs in the
background and reports back to the chat when done.

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
download or save something, because this is exactly the tool for it. It lists four
MUST-call cases:

1. The user asks to download or save a file, video, image or document.
2. The user names a specific site, service or page to get data **from**.
3. The user wants a **live or current** value that a search snippet cannot give
   reliably — a live viewer count, live stats, a chart or dashboard, a current price
   or availability — because those pages compute their numbers in the browser.
   (Commodity live values a plain search shows accurately — weather, current time, a
   well-known exchange rate — do not need this.)
4. The task needs multi-step interaction on the web.

It also says to call in those cases **even if** a similar question earlier in the same
conversation was answered from a search snippet — because the base system prompt
warns the model that its own past replies may have settled for less than the fullest
available capability.

Anyone may start a run. The **download tools inside the run** are gated to
owner-started runs, resolved at enqueue time — not at call time, and not from
anything the model says.

## The agent

`server/agent.ts`: one goal, run to completion in one session, driven by the
configured chat model over the shared tool loop.

Deliberately **unbounded** (recorded decision): no round cap, no wall-clock cap. Only
the loop's stall guard ends a run that stops progressing — three rounds that each
introduce no new tool call — and its forced tools-free final round then salvages a
report from whatever was gathered.

### The toolset

Generic primitives only. Recorded decision: **no scenario-specific tools** — the
model composes primitives rather than the code encoding any one task. Finding "the
video" is the model's job: it reads the page or the network, picks the URL, and calls
the matching download tool. There is no media-sniffing heuristic baked in.

| Tool | Purpose |
| --- | --- |
| `browser_navigate`, `browser_back` | Movement |
| `browser_click`, `browser_type`, `browser_scroll` | Interaction, by element ref |
| `browser_read`, `browser_source` | Readable text / raw source |
| `browser_get_network` | Inspect the requests the page made — how a stream URL is found |
| `browser_screenshot` | Capture (stored in Postgres) |
| `browser_wait` | Let a page settle |
| `browser_download_file` | Stream a direct URL to disk (plain HTTP) |
| `browser_download_stream` | Mux an HLS/DASH **manifest** into a single MP4 with ffmpeg |

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
scheduled-tasks poller. A single run executes at a time; the queue **is** the
`browser_agent_runs` table.

- Enqueuers insert a `queued` row and then call `emitRunEnqueued()` (`signal.ts`, a
  `globalThis` singleton), so a new run is picked up immediately rather than waiting
  for a poll.
- At boot, a crash-safety sweep fails any run left `running` by a previous process.
- A run with no LLM configured settles as a **failure** rather than hanging.

### Delivery

Mirrors the MVP:

- Each downloaded file is posted to the chat **the moment it lands**, silently, as an
  intermediate progress message — provided it is within
  `settings.browser_download_max_mb` (1–50; 50 is Telegram's bot upload ceiling).
  Larger files stay in the downloads folder and the tool result says so. That folder
  (`DOWNLOADS_DIR` — `/app/data/downloads` under Compose, bind-mounted to the host;
  `./downloads` locally) is the **only** copy of such a file, which is why it is a
  mounted directory rather than a container path.
- The agent's final report is delivered at the end and mirrored into history.
- A **dashboard-started run has no `chatId`** and delivers nothing; its report is
  stored on the run row and read on the page.

A separate hard cap protects the disk: a single download may not exceed 2 GB.

### Stream downloads

`stream-download.ts` handles the HLS/DASH case. `hls.ts` (pure, unit-tested against
real playlists) parses a master playlist and picks the best-quality video variant plus
its demuxed audio when the master carries audio separately — so a downloaded stream
is not ffmpeg's default lowest rung and does not lose its soundtrack.

SSRF: ffmpeg's own redirects are out of our hands, so the **manifest** is checked and
only public hosts are handed to ffmpeg.

## Live state

`server/live-state.ts` holds what a running run is doing *right now* and its download
progress. Deliberately **not persisted**: it changes many times a second during a
download, and a run that dies mid-flight is swept to `failed` anyway, so durability
buys nothing. The runner writes it; the run-detail API reads it (same process).

## Data

| Table | Notes |
| --- | --- |
| `browser_agent_runs` | The queue and the record. `status`, `goal`, `report`, `error`, `steps`, `activity` (jsonb step feed), `downloads` (jsonb), `is_owner`, `trace_id` |
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
| `llmBaseUrl` + `model` | Without them a run settles as a failure |
| `ownerUserId` | Only owner-started runs may download |
| `browserDownloadMaxMb` | Largest file also attached to the chat (1–50) |

Needs a working Chromium and ffmpeg. Both are in the Docker image.

## Tracing

Tracing lives in the **runner**, where the work happens — enqueuing is a plain insert.
Feature `browser-agent`, `relatedIdsKey` `browser_agent_runs`, and the run row carries
the `trace_id` for drill-down. The `browse_web` dispatch call is separately traced
under `mcp-tools-browser-agent`.

## Tests

Unit: `files.test.ts`, `format.test.ts`, `hls.test.ts`, `snapshot.test.ts`.
Integration (live, and marked as such): `server/browse-live.integration.test.ts`,
`server/browser-agent.integration.test.ts`,
`server/primitives-live.integration.test.ts`,
`server/tool-selection.integration.test.ts`.
