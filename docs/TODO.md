# TODO

The working tracker for pending work. It replaced `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md` (retired 2026-07-27): the v1 rewrite is complete,
so the phase plan, per-feature progress tables, session logs and the historical
Decision Notes are archive material — recoverable from git history — and only
the still-actionable information was carried forward here.

How to use this file:

- Update it before and after substantial work; statuses are `todo`,
  `in-progress`, `blocked`, `done`, `deferred`.
- A `done` entry records proof (files changed, tests run, build/typecheck/lint
  status, remaining risks) — and is then **pruned** once the work is shipped and
  documented under `docs/`. Git history is the archive; this file holds only
  open work.
- A `blocked` entry records the blocker, the attempted approach, and the next
  decision needed.
- Decisions are made by asking the user and recording the outcome against the
  entry it belongs to, here (no `docs/decisions/*.md` files).
- At handoff, leave short notes here: current state, next best task, known
  pitfalls, commands that passed or failed.

## Current state

v1 (priorities 1–14 in `AGENTS.md`) is complete and deployed: the app
independently runs the bot, dashboard, persistence, background jobs and Docker
deployment. Priorities 5–6 (search / read-link MCP tools) were later
superseded — `browse_web` is the only web tool (user decision, 2026-07-26).

## The bot said a task was cancelled after `tasks_delete` failed (`done` pending production deploy + live verification, 2026-08-05)

Traces `1f300347…` (reply), `5d33d8c1…` (`tasks_list`), `c757d10a…`
(`tasks_delete`), all 2026-08-05 12:08 Kyiv. A user asked, in reply to the bot,
to cancel a task. Round 1 called `tasks_list` and got the four tasks back. Round
2 called `tasks_delete` with the right task's id **minus one character** — the
model dropped a `6` out of the last group while copying. The tool answered `No
task <id> in this chat.`, and the final round answered that it was done. The task
is still scheduled.

Two independent failures, fixed separately.

### 1. The error told the model nothing it could act on

`checkOwnership` returned the same sentence for a mistyped id, a deleted task and
another chat's task. The model's own reasoning shows it working the case and
giving up — *"it was there a millisecond ago… maybe a race condition"* — because
nothing in the result said the id was malformed, and it had no list to re-copy
from. The loop had rounds left; it just had nothing to retry with.

- `isTaskId` (ids are `randomUUID()` values) and `unknownTaskText`, both pure and
  pinned by tests, in `features/scheduled-tasks/server/mcp-tools.ts`. The miss
  now says which case it is and lists the chat's actual ids to copy from — ids
  `tasks_list` already showed, so nothing new is exposed.
- One `guardMutation` used by `tasks_update`/`tasks_delete`, and the same text on
  `tasks_get`; the chat's ids are loaded **only** on a miss.
- Matching stays exact. Nothing is resolved by prefix or similarity, least of all
  for a delete — the fix is to let the model retry correctly, not to guess for it.

### 2. The reply claimed success over a failed tool call

The worse half. The `Honesty` block of the reply prompt forbids exactly this, in
five sentences, and the model read the failure, spent ~1 400 reasoning tokens
unable to explain it, and wrote "done" anyway. By the final round those rules are
thousands of tokens back and the failure is one unremarkable `tool` message.

- `toolFailureNotice` + a **system turn** appended after any round with a failed
  call (`server/llm/tool-loop.ts`): names the tool and its error, states that
  nothing was done, and gives the two allowed exits — fix the call and retry, or
  tell the user it failed. Generic in the loop, so every feature's tools get it.
- Same shape as the rule-turn enforcement directive below: standing prompt text
  that was ignored is restated at the moment of the decision, and tool *selection*
  is still the model's.

### 3. A failed tool call was traced green

`tracedToolCall` settled `success` for an `isError` result, on the reasoning that
the tool ran. Wrong unit for an operator: the failed `tasks_delete` sat in Debug
as a green row. It now settles `error` with the tool's own message; the result
still reaches the model unchanged. Scoped to `mcp-tools-*` traces, so the
analytics traffic tiles (which count `bot-messaging` only) are untouched.

*Proof.* Files — `server/llm/tool-loop.ts`, `server/mcp/tool-trace.ts`,
`features/scheduled-tasks/server/mcp-tools.ts` (+ all three test files); docs
`architecture/llm-and-mcp.md`, `features/scheduled-tasks.md`. Tests —
`npm run lint` ✅, `npm run typecheck` ✅, `npm test` 950 passed / 21 failed,
those 21 being the known Windows yt-dlp environment failures (same 2 files, same
count as the 2026-08-03 entry below, and neither file imports anything touched
here). New: 3 tool-loop cases (notice content, no notice on success, several
failures in one notice), 1 tool-trace case reworked to the failed status, 9
scheduled-tasks cases (`isTaskId`, `unknownTaskText`, ids handed back on a miss).
`npm run build` not run (would kill the running dev server).

*Remaining risks / live verification checklist (after deploy).*

- Ask the bot in the group to cancel a task and confirm the task actually
  disappears from `/scheduled-tasks`. The interesting run is a *failed* first
  attempt: watch `/debug?feature=mcp-tools-scheduled-tasks` for a **red**
  `tasks_delete`, then check whether the same reply trace shows a second
  `tasks_delete` with a corrected id (the retry landing) or a reply that admits
  the failure. Either is the fix working; "done" with no successful delete is not.
- The notice is English inside a Ukrainian-language turn, like the other
  enforcement text. If it starts leaking into replies verbatim, reword it.
- The id list rides in a tool error, so a chat with many tasks makes that message
  long. Cap it if a chat ever grows past a few dozen tasks.

## A rule turn that called no tool + no recovery from a hung LLM call (`done` pending production deploy + live verification, 2026-08-03)

Two user reports from the same afternoon on the live bot, unrelated in cause.

### 1. The bot said it downloaded a video and downloaded nothing

Trace `ec543b22…` (2026-08-03 15:47 Kyiv). A bare `x.com` link matched the
group's download rule and everything up to the model worked: the matcher cited
the link verbatim, the addressing check opened the turn on the rule's authority,
the directive went in last, all 25 tools including `browse_web` were in the
request. The model then produced **text only** — `finish_reason: "stop"`, no
`tool_calls` — saying it had downloaded the video, with an invented author
handle. Its reasoning block reads *"Action: Use `browse_web` to get the content
of this URL"*, so the call was decided and then not emitted. No
`browser_agent_runs` row exists; the last run on the box was the previous
evening.

Frequency, from all 94 retained successful `bot-messaging` traces on the live
instance: 9 rule-opened turns, **8 called `browse_web`, 1 did not**. Prompt size
is not the discriminator (a 25 103-token turn succeeded; this 23 058-token one
failed), and neither is the site (an `x.com` link went through on 08-01). Same
gemma4:12b tool-avoidance family as the `tasks_list`/`rules_create` items below,
now landing on the one path that *promises the chat an artifact*.

*Decision (operator, 2026-08-03): retry once, then suppress — "but don't be
silent about it".* Also asked and answered: **do not** pursue the standing
model-replacement question yet; fix the guard and record this as evidence.

Note this does not reopen "we never solve model problems by code". Tool
*selection* is still left to the model — nothing is forced, nothing is gated, and
the enforcement directive offers "say you could not do it" as an equally correct
answer. What code now checks is a mechanical fact it is entitled to check: a
directive was injected and `onToolCall` never fired, so the answer's central
claim is false. Same shape as the matcher's citation check.

- `RULE_ENFORCEMENT_DIRECTIVE` (`features/chat-rules/format.ts`) — shown only
  after the failure, with the empty-handed answer appended to the conversation
  in front of it. Deliberately not standing prompt text: the Honesty block, the
  rules block and the trigger directive already said this three times and were
  ignored in this very turn.
- Enforcement in `features/bot-messaging/server/service.ts` (step 4d): tool calls
  counted; one retry; if the retry is also empty-handed the answer is **never
  sent**, a labeled system notice (`RULE_NOT_APPLIED_REPLY`) goes to the chat
  instead, the notice is not mirrored into history, and the trace **fails** so
  the turn is findable on `/debug` (a green trace is how the first one went
  unnoticed for a day).
- Unreachable on an ordinary turn: only a turn nobody addressed gets a directive.

### 2. A hung LLM call lost the reply, with the endpoint healthy

Trace `82a8976c…` (15:51). The reply request died at exactly **120.005 s** with
`Connection to … timed out`, and the operator confirmed Ollama was up. The live
call timeline backs that: the rule match 8 s earlier was fine, and the next
message's classification answered in 11 s starting **0.2 s after** the timeout.
No self-inflicted load either — the poller processes messages serially, and the
only other traces in the window are `vision-backfill` runs finishing in ~20 ms.
One connection hung; `maxRetries: 0` and nothing above it retried, so the group
got the error notice.

*Decisions (operator, 2026-08-03): 90 s timeout × 2 attempts; retry all
interactive calls, not just replies.*

- `CHAT_COMPLETION_TIMEOUT_MS` 120 s → **90 s** (sized from measured traces:
  replies run 40–70 s, slowest successful rule download 66 s).
- `withLlmRetry` + `isRetryableLlmError` (`server/llm/client.ts`), used by both
  completion paths. Judges the **raw** SDK error — `toLlmError` flattens a 400
  and a dropped connection alike to `service_unavailable`. Retries connection
  errors/timeouts and 5xx; never a 4xx, a context overflow, or an empty
  completion (the empty check moved *outside* the retry wrapper for that reason).
  Background calls keep a single attempt — they wait for a quiet endpoint, have
  a 300 s deadline, and re-run on their own schedule.
- The retry sits per **round** in the tool loop, so a hung connection after a
  download re-asks the model with the tool result in hand rather than
  re-downloading. Pinned by a test.
- Visible, not silent: `onRetry` → a `warn` step on the reply trace, so a turn
  that took two attempts cannot pass for a clean one.

*Proof.* Files — `server/llm/{client,tool-loop}.ts`,
`features/bot-messaging/server/service.ts`, `features/chat-rules/format.ts`,
`server/telegram/process-update.ts`; docs
`features/{chat-rules,bot-messaging}.md`, `architecture/llm-and-mcp.md`. Tests —
`npm run lint` ✅, `npm run typecheck` ✅, `npm test` 936 passed / 21 failed,
those 21 being the known Windows yt-dlp environment failures (verified identical
on a stashed clean tree: same 2 files, same 21). New: 7 service cases (retry
composition, delivery after a successful retry, suppression + notice, failed
trace, no history mirror, and both untouched-ordinary-turn cases), 1 retry-step
case, 4 `isRetryableLlmError` cases, 4 `chatCompletion` retry cases, 1 tool-loop
round-retry case, 1 directive-pinning case. The openai mock in both LLM test
files now has `APIConnectionTimeoutError extends APIConnectionError`, matching
the real SDK hierarchy the predicate relies on. `npm run build` not run (would
kill the running dev server).

*Remaining risks / live verification checklist (after deploy).*

- Post a social-media link in the rule-bearing group and confirm the video
  arrives. The case that needs patience is the failure one: it is ~1 turn in 9,
  so watch `/debug?feature=bot-messaging` for a **red** reply trace carrying
  `rule turn answered without calling any tool — retrying`. A trace with that
  step and a green outcome is the retry working, which is the outcome to hope
  for.
- Confirm the system notice reads acceptably in the group when it does fire —
  it is English by design (same rule as the other two notices).
- Watch for `LLM call failed — retrying` steps. A rash of them means the endpoint
  is unwell rather than the timeout being wrong; none at all over a week of the
  90 s deadline means the deadline could go lower still.
- ~~Unverified assumption: that 90 s never cuts off a legitimately slow turn.~~
  **It did, within the hour — see the round below.**
- The enforcement is prompt-plus-suppression, and the retry half is still the
  same model that ignored three standing instructions. The suppression half is
  not — it holds regardless of what the model does. Feeds the standing
  model-replacement question below.

### Round 2 — 90 s was under the reply tail (same day, deployed)

Two live traces from the first hour after deploy settled the deadline question
the checklist above left open, in both directions.

- **The retry works.** Trace at 14:57: a rule-driven Instagram download whose
  reply round hung and was cut at 90 s, recovered on the retry (~62 s), called
  `browse_web`, hung again on the next round, recovered again, and **delivered
  the video**. Two hung rounds, one delivered file. Under the pre-deploy code
  that turn fails.
- **But the deadline was too tight.** Trace `93a963ec…` (15:03): both attempts
  cut at exactly 90.003 s and 90.008 s on a round that was working, just slowly.
  The retry cannot help here by construction — a round that needs 95 s needs
  95 s on the second attempt too, and retrying restarts prefill and decode from
  nothing.

The 90 s came from the 9 rule-download turns (40–70 s), which was the wrong
sample. Over all 118 successful reply rounds on the box: median 18.9 s, p75
38.2 s, p90 54.7 s, p95 68.3 s, **max 95.8 s**, with 2 rounds past 90 s. The
classifications are a different distribution entirely — ~500-token prompt,
median 15–25 s per hour across the whole retained window, **max 57.7 s** — and
that flatness also rules out "the endpoint is degrading": it spikes per call
(a 17 s classification occasionally taking 57 s), it does not drift.

*Decision (operator, 2026-08-03): 150 s for replies, 90 s for classifications.*
The two shapes get their own deadline rather than sharing the reply's.

- New `REPLY_CHAT_COMPLETION_TIMEOUT_MS` = 150 s in `server/llm/client.ts`
  (beside the other two deadlines — the client already owns this vocabulary),
  passed explicitly by both reply paths in `process-update.ts`. ~1.6× the
  slowest legitimate round on record.
- `CHAT_COMPLETION_TIMEOUT_MS` stays 90 s and is now, in practice, the
  classification deadline — 1.5× their 57.7 s worst case — so a hung
  classification still fails over fast instead of inheriting a reply-sized wait.
- The doc comments now state the division of labour explicitly, because getting
  it wrong is what round 1 did: **the retry is for a request that never got
  going; the deadline is for one that is merely slow.**
- Pinned by a test on the ordering and the observed-maximum headroom, so the
  three deadlines cannot silently collapse back into one.

*Proof.* Files — `server/llm/client.ts`, `server/telegram/process-update.ts`,
`docs/architecture/llm-and-mcp.md`. `npm run lint` ✅, `npm run typecheck` ✅,
`server/llm` 71 passed (2 new deadline cases).

*Still open.* 150 s is headroom over the *observed* max, not a proof. If a reply
fails twice at 150 s, that is a genuinely stuck endpoint rather than a tuning
problem — check `/api/ps` and the `OLLAMA_NUM_PARALLEL`/VRAM note below before
raising it again. Worst case a person now waits ~5 min before the error notice.
Also unaddressed and visible in the same window: `history-summaries` failed
twice at 418 s and 340 s against its 300 s background deadline, which is the
batch-size question already flagged under the priority-gate entry.

## Restricted rule-driven downloads: stranded files + substitute download (`done` pending production deploy + live verification, 2026-08-01)

Two incidents in the group, same afternoon, both children of the owner's
"download social-network media links" rule (traces `1747a84c…`/`f458155f…` and
`dc7df92e…`/`35dc99a4…`):

1. A member asked for a YouTube video; the rule matcher (gemma4:12b) matched the
   YouTube link to the "x.com, tiktok, instagram" rule, lent the owner's rights,
   and the 77 MB result exceeded the 20 MB attach cap — so it was "kept" on the
   server and the chat was told the file is in "your downloads folder", which no
   chat user can reach.
2. A bare x.com link opened a rule turn; the chat model composed the goal with a
   **flipped digit in the 19-digit tweet id** (`…702` → `…102`) *and* appended
   "(або аналогічний відео/медіа файл)" — the exact softener `browse_web`'s
   description forbids. The sub-agent, unable to download the (mangled) tweet,
   searched "popular music videos 2024" and delivered Maroon 5's "Sugar" as a
   "similar" file, kept on disk, reported as success.

*Decisions (operator, 2026-08-01).*

- **Attach or fail** for **restricted** runs: a download the chat cannot take is
  deleted, not kept; the run's report says the delivery failed and is sent
  **silent** (no ping). Restricted (second decision, same day: *"it has to be
  the same for the owner in a group chat"*) = a standing rule drove the run in
  a **group** — the owner's own message included — or lent the sender rights
  they did not hold. The owner's direct requests, their own DM rules, and
  dashboard runs stay unrestricted (kept on disk as before).
- **The attach cap is not a setting.** `browser_download_max_mb` removed from
  settings/dashboard; fixed at Telegram's 50 MB bot upload ceiling
  (`TELEGRAM_MAX_UPLOAD_MB`, `lib/telegram.ts`).
- **Hard data does not pass through an LLM.** Message URLs are extracted in code
  (`features/browser-agent/urls.ts`), bound to the tool context
  (`McpToolContext.messageUrls`), stored on the run (`source_urls`), appended
  verbatim to the agent's goal message, and — for a `restricted` run (new
  column) — the download tools accept **only** those URLs or same-site ones
  (subdomain folding + `youtu.be`↔`youtube.com`, `x.com`↔`twitter.com`
  aliases). Rule-driven-ness is detected as `authorityUserId` being bound on
  the turn: the matcher only binds it when a rule with rights actually
  matched, and it is skipped on the owner's direct (addressed) requests.
  Declined alternatives: deterministic domain-matching for rules, dropping
  elevation entirely.
- **Prompt hardening**: the agent system prompt forbids substitute/"similar"
  downloads — a failed target is a failed run, reported honestly.
- **Local Bot API server** (2 GB uploads) deferred — see Other open items.

*Files.* New — `features/browser-agent/urls.ts` (+ `urls.test.ts`),
`db/migrations/0046_lonely_ben_parker.sql`. Changed — `lib/telegram.ts`,
`db/schema.ts`, `server/mcp/context.ts`, `server/telegram/process-update.ts`,
`features/browser-agent/{types,format}.ts`,
`features/browser-agent/server/{agent,tools,runner,repository,service,mcp-tools}.ts`
(+ `tools.test.ts`, `mcp-tools.test.ts`, `browse-live.integration.test.ts`),
`features/settings/server/{schema,repository,service}.ts` (+ integration test),
`features/settings/ui/SettingsForm.tsx`,
`features/chat-rules/server/live-flow.integration.test.ts`, docs
(`configuration.md`, `architecture/{data-model,security}.md`,
`features/{browser-agent,chat-rules}.md`, `operations/operator-guide.md`,
`api/openapi.yaml`).

*Verification.* `npm run lint` clean, `npm run typecheck` clean, `npm test` 90
files / 930 passed (new: 12 for `urls.ts`, 3 dispatcher cases — URL fence,
alias, discard; enqueue elevation/sourceUrls pins), `npm run test:integration`
25 files / 338 passed / 41 live-LLM skipped. `npm run build` **blocked** by the
known `data/pg` EACCES (fifth recurrence, tracked below; reproduces with the
changes stashed).

*Deployment finding (2026-08-01).* Asked to "kill the running server and
migrate", it turned out **the production bot does not run on this machine**: no
app process or container, no built image, no `data/traces/traces-2026-08.ndjson`
anywhere on disk, and the local Postgres (`llm-tg-bot-nextjs-db-1`) holds zero
messages for the incident group, none of today's runs, and no client
connections — this checkout + DB is the dev environment. Migration 0046 **was
applied to the dev DB** (`npm run db:migrate`, journal at 0046); the production
deployment (wherever it lives) still needs: pull this code, rebuild the image,
run the migration during the restart. The stale memory that production runs
from this working copy has been corrected.

*Remaining risks / next steps.*

- **Production deploy + migration** are the operator's (or need access details):
  migration 0046 drops `settings.browser_download_max_mb`, which older builds
  still select — apply it together with the code, during the restart.
- **Live re-test** (operator): repeat both incidents — a YouTube link from a
  non-owner (expect: download refused as out of rule scope, or delivered if it
  fits 50 MB once the matcher fires; nothing new left in `data/downloads`), and
  a dead x.com link (expect: honest failure report, silent, no substitute file).
  Also the owner's own link in the group via the rule: >50 MB must now be
  discarded + reported silent, not kept.
- The two stranded incident files (`Maroon 5 - Sugar….mp4`,
  `Mission… Impossible….mp4`, ~140 MB) are on the production host's
  `data/downloads` — delete there.
- Accepted limitation: on a restricted run, a direct-file/stream URL on a CDN
  host differing from the message's site is refused too; the rule use-case is
  media pages, where `browser_download_media` takes the page URL itself.
- The host alias table is deliberately tiny (`youtu.be`, `x.com`); a new
  share-domain alias (e.g. a future shortener) needs a one-line addition in
  `urls.ts`.
- The rule matcher still over-matches ("such as" lists judged by gemma4:12b) —
  now bounded in blast radius rather than fixed; folds into the standing
  model-replacement question.

## Keeping yt-dlp up to date (`done` pending live verification, 2026-08-01)

*Why.* The image installed yt-dlp from `apk`, which is frozen per Alpine release: the
copy on this machine was `2026.03.17` against upstream's `2026.07.04`, four months and
many YouTube-side changes behind. The recorded remedy ("rebuild against a newer base
image") was never reliable — a rebuild only moves to whatever Alpine froze next. And
the failure is silent: a stale yt-dlp does not warn, it answers *every* media page with
an extraction error until a user's request fails.

*Decisions (operator, 2026-08-01).* Asked with four options (runtime auto-update job /
pinned binary rebuilt manually / pip in the Dockerfile / host-side rebuild cadence).
Chosen: **runtime auto-update job**, with the downloaded binary **ephemeral** — kept in
`/app/data/bin` inside the container, re-downloaded on boot after a recreate, rather
than bind-mounted. Rationale for ephemeral: no Compose change and no host directory
whose ownership must be kept right for the non-root `app` user; the cost is one ~40 MB
download per redeploy.

*What shipped.* The Dockerfile now installs upstream's self-contained `musllinux`
build, pinned by version + SHA-256 and arch-selected, instead of `apk add yt-dlp` —
which also drops python3 from the image. That build is only the floor: a daily job on
the shared daily-job model checks GitHub's latest release, verifies the asset against
the release's `SHA2-256SUMS`, **runs it from a temp path**, and only then renames it
over `data/bin/yt-dlp`. The media downloader resolves its command per download, so an
update lands without a restart. A container with no managed copy checks once at boot
instead of waiting for the night.

Failure design: every expected dead end (unsupported platform, already current, GitHub
unreachable or rate-limiting, no usable asset) settles as a no-op summary; only a
checksum mismatch or a downloaded binary that will not run raises — and neither can
replace the working binary, because the rename happens last.

*Files.* New — `features/browser-agent/ytdlp-release.ts` (+test),
`features/browser-agent/server/ytdlp-binary.ts` (+test),
`features/browser-agent/server/ytdlp-scheduler.ts`,
`features/browser-agent/ui/YtDlpJobCard.tsx`, `app/api/browser/ytdlp/run/route.ts`.
Changed — `Dockerfile`, `server/paths.ts` (`binDir()`),
`features/browser-agent/server/media-download.ts` (resolver),
`server/telegram/register-node.ts`, `lib/features.ts` (`ytdlp-updater`),
`features/jobs/server/registry.ts` (+test), `app/(dashboard)/browser/page.tsx`,
`features/browser-agent/server/media-download.test.ts`. Docs — `getting-started.md`,
`architecture/{overview,security,background-jobs}.md`,
`operations/{deployment,troubleshooting,operator-guide}.md`,
`features/{README,browser-agent}.md`, `api/{README,endpoints,openapi.yaml}`.

*Verification.* `npm run lint` clean, `npm run typecheck` clean, `npm run test` 89
files / 915 tests passing (38 new: 20 for the release helpers, 15 for the updater, 1
for the managed-binary preference, 2 for the job view). `npm run build` **fails**, but
not because of this change: Turbopack's tree walk hits `data/pg` (owned by the
container's postgres uid, `drwx------`) and dies with `Permission denied`. Confirmed
pre-existing by stashing every change and rebuilding — same error, same directory,
just named against `server/download.ts` instead. Fixed on the operator's side with
`sudo chmod -R g+rX data/pg`.

*Remaining risks / next steps.*
- **Not verified live.** The updater has never run against real GitHub: the tests stub
  `fetch`. First real proof is hitting **Run now** on the yt-dlp updater card and
  seeing the version badge move off the image's pinned build.
- The image change needs a rebuild before the deployment has any of this; until then
  the running container still has the apk `yt-dlp`.
- Integrity, not provenance: `SHA2-256SUMS.sig` is not checked (no GPG keyring in the
  image). Recorded in `docs/architecture/security.md`.
- The boot check re-downloads ~40 MB after every container recreate, by design.

## Poller does not survive an outage; Stop does nothing (`done` pending live verification, 2026-08-01)

User report: after a few hours without an internet connection the bot never came
back, and Stop on the dashboard did nothing at all. Both are one root cause, in
`@grammyjs/runner`'s defaults.

*What happened.* The runner's update fetcher retries a failing `getUpdates` with
**uncapped doubling** backoff (100ms → 200 → … ) for up to **15 hours**. After
three hours down, the next attempt had been scheduled roughly three hours out, so
the connection returning changed nothing. That sleep is a bare `setTimeout` the
abort signal cannot interrupt — and `runner.stop()`'s promise only settles once
the fetch loop unwinds. `stopBotInternal` awaited it, holding `transitioning`
true for the whole sleep, so the dashboard POST hung and every later start/stop
returned the stale status immediately. Hence "nothing happened".

*Fixes* (`server/telegram/bot-manager.ts`):
- `maxRetryTime: 30_000` on the runner, so a drop surfaces in a window instead of
  disappearing into a multi-hour sleep.
- Reconnect supervision owned by the manager: a flat **15s** retry for as long as
  the failure is a network one (`HttpError`, plus a handshake that outran the new
  20s deadline), driven by a `desired` flag that Stop withdraws. A `GrammyError`
  (Telegram answered and refused — revoked token, second poller) settles as a
  plain error rather than spinning. Status carries `reconnecting automatically`;
  logging is edge-triggered, one line down and one back up.
- `stopBotInternal` detaches after a **3s** drain instead of awaiting the sleep.
  Safe because the abort is synchronous — the detached loop throws on its next
  fetch. The task-rejection handler now checks runner identity, so a late
  rejection from a replaced runner cannot clobber a live bot (a pre-existing bug:
  it would have nulled the *new* bot).
- `bot.init()` bounded by `initWithDeadline` (grammy's own client timeout is
  500s — long enough to hold the transition lock and the request behind it).
- `register-node.ts`: the autostart promise has a `catch`, so a boot with the
  database unreachable no longer ends in an unhandled rejection.

Proof: files `server/telegram/{bot-manager,register-node}.ts`, new
`server/telegram/bot-manager.test.ts` (10 — retry window, handshake deadline,
self-reconnect, keeps retrying while the outage lasts, no spin on a refused
token, stale-runner rejection ignored, Stop answers while the loop is asleep,
Stop leaves the manager startable, Stop cancels a pending reconnect), docs
(`docs/architecture/telegram-pipeline.md` new "Losing the connection" section,
`docs/operations/troubleshooting.md`). `npm run lint`, `npm run typecheck`,
`npm test` (87 files / 877) all clean; `npm run build` blocked again by the
`data/pg` EACCES tracked below (fourth recurrence — needs the operator chmod).

Remaining risks / next steps:
- **Live verification:** pull the network for a few minutes with the bot running.
  Expect the status to flip to error + `reconnecting automatically`, one log line,
  and the bot back within ~15s of the link returning — and Stop to answer at any
  point during it. Only the mocked lifecycle has been exercised so far.
- 15s of retries costs nothing while down (each attempt fails at connect), but on
  a *partial* outage where Telegram answers slowly, attempts overlap the 20s
  handshake deadline. Accepted: the transition lock serialises them.
- A drop is still invisible until the runner gives up (up to 30s of its own
  retrying); no "degraded" state is surfaced during that window.

## Scheduled-task context on update + delivery-history pollution (`done` pending live verification, 2026-08-01)

Two user reports against the round-3 `context` work tracked under "Context-free
reminders" below.

1. **Context is not gathered when a task is updated via MCP.** The GATHER CONTEXT
   rule lived only on `tasks_create`, and `tasks_update`'s description said
   nothing beyond "only the fields you pass are changed" — so the very case the
   context column exists for (a user handing over the background a thin existing
   task was missing) went through with nothing gathered. New exported
   `TASKS_UPDATE_DESCRIPTION` carries the create rule reworded for updates,
   naming that case explicitly, warning against leaving stale context behind a
   changed instruction, and exempting a pure schedule/enabled change. The
   `instruction`/`context` field descriptions were tightened to match. Context is
   now also *visible* to the model: `tasks_get` and the create/update
   confirmations print it (new `taskText`), and `tasks_list` flags a task that has
   none — previously the tool text showed only `summarizeTask`, so the model could
   not tell whether a task carried any background at all.
2. **Recent deliveries polluted the fire.** The last five delivered texts are fed
   back for wording variation, but nothing said so: a hallucination in one fire
   read as context for the next and compounded. `buildTaskDirectiveMessage`'s
   block is now labelled `WORDING REFERENCE ONLY`, states they are the bot's own
   past messages, not a source of facts, may be wrong/stale/invented, and that
   anything in them not in the directive or saved context must not be repeated or
   built on. Same source ranking `BASE_SYSTEM_PROMPT`'s Grounding block applies to
   the bot's own transcript lines.

Proof: files `features/scheduled-tasks/server/{mcp-tools,fire}.ts` (+
`mcp-tools.test.ts` 5 new pinning cases, `fire.test.ts` 1 new),
`docs/features/scheduled-tasks.md` (which had never documented `context` at all —
the Saved context section and the `context` key column are new). `npm run lint`,
`npm run typecheck`, `npm test` (87 files / 877), `npm run test:integration
features/scheduled-tasks` (22 passed / 7 live-LLM skipped) all clean.

Remaining risks / next steps: this is prompt text against gemma4:12b, the same
model that ignored rounds 1–3 of the create-side rule — see the tool-avoidance
item below. **Live re-test:** give the bot the background for an existing
context-less task in chat and confirm the `tasks_update` call actually carried a
`context` (not just a claim that it did), then let the task fire.

## Browser-agent chat delivery overhaul (`done` pending live verification, 2026-08-01)

User report (2026-08-01, after the first live rule-driven Instagram download): the
video arrived as a plain document instead of a playable video, and the flow was
three messages where one or two would do (the "Завантажую контент" ack, the file,
then a report repeating the filename). Three changes, all user-requested:

1. **Playable media.** `sendChatDocument` became `sendChatFile`
   (`server/telegram/bot-manager.ts`): the send method is picked from the mime by
   the new pure `telegramFileKind` (`lib/telegram.ts`) — `sendVideo` (with
   `supports_streaming`) for MP4/QuickTime, `sendAudio` for MP3/M4A, `sendDocument`
   otherwise, with a document fallback when Telegram rejects the media kind
   (`GrammyError` only — a network error still throws, a blind retry could
   double-send). Captions render HTML-with-plain-fallback like messages.
2. **File + report in one message.** Attachable downloads are no longer sent as
   they land; `onDownload` stages them (`"staged" | "kept"` — new
   `DownloadOutcome` in `tools.ts`; `CollectedFile` gained `filePath`) and the
   runner delivers at settle: a single staged file with a caption-sized report
   goes out as ONE combined message; otherwise files under their own line + the
   report as text. The recap lists only files that did NOT reach the chat. The
   disk copy now survives until the send succeeds (previously unlinked at
   download time on delivery); a failed run still delivers its staged files
   before the failure notice.
3. **Silent, self-deleting ack.** `browse_web` reports the enqueued run to the
   turn via `McpToolContext.onBrowserRunEnqueued`; the reply pipeline then sends
   the model's "on it" reply with `disable_notification` and registers each
   delivered chunk in the new in-memory ack store
   (`features/browser-agent/server/ack.ts`, `globalThis` like `signal.ts`). The
   runner deletes the ack (new `deleteChatMessage`) after posting the outcome, on
   success and failure, and soft-deletes its history-mirror row (new
   `markMessageDeleted` in history service + `markChatMessageDeleted` repository
   fn — first writer of the existing `deleted_at` column). Race-safe both ways: a
   run that settles first leaves a marker and the late-arriving ack is deleted on
   registration (via the new optional `ReplyTransport.deleteMessage`).

Proof: files — `lib/telegram.ts` (+ new `telegram.test.ts`),
`server/telegram/{bot-manager,transport,process-update}.ts`,
`server/mcp/context.ts`, `features/browser-agent/server/{tools,runner,mcp-tools}.ts`,
new `features/browser-agent/server/ack.ts` (+ `ack.test.ts`),
`features/browser-agent/format.ts` (doc),
`features/history/server/{repository,service}.ts`,
`docs/features/browser-agent.md`. Tests: `npm run lint`, `npm run typecheck`,
`npm test` (86 files / 861), `npm run test:integration` (338 passed / 41
live-LLM skipped) all clean; `tools.test.ts` reworked to the staged contract,
`mcp-tools.test.ts` gained the ack-wiring case. `npm run build` could NOT be
run: the known `data/pg` Turbopack EACCES recurred (third time — tracked below;
needs the operator chmod), and reproduces with these changes stashed.

Remaining risks / next steps:
- Live verification: send a social-media video link through the bot again — the
  ack should arrive without a ping and vanish when the video posts; the video
  should play inline and carry the report as its caption; `downloads/` should not
  keep a copy.
- The report is the caption now, so a >1024-char report degrades to the old
  two-message form by design.
- The ack of a run that outlives a server restart is not deleted (in-memory
  store; accepted — cosmetic).
- An ERROR_REPLY sent after a turn that enqueued a run goes out silent too (the
  send closure cannot tell it apart); it is never registered as an ack, so it is
  not deleted. Accepted.

## Browser-agent context-window exhaustion (`done`, 2026-07-30)

Root cause of trace `622483e0…` (browser-agent run failed with
`service_unavailable: LLM returned an empty response`): the run's prompt grew
monotonically (every stale page snapshot and 20k-char `browser_source` chunk
carried verbatim forever) until it filled the Ollama server's 32,768-token
window; the final round was cut off (`finish_reason: "length"`) before emitting
content or a tool call, and the loop reported that as a plain empty response —
with the download URL already found. Server side, the window was raised the
same day (`OLLAMA_CONTEXT_LENGTH`, verified loaded at 256,000 via `/api/ps`;
the model's native max is 262,144, and Ollama's OpenAI-compatible API has no
per-request way to set context size). App-side fixes:

- **Conversation compaction** — `RunToolLoopParams.compact` rewrites what each
  round *sends* (copy per round; kept history stays complete), wired for the
  browser agent as `compactAgentConversation`: every page-state snapshot but
  the latest, every `browser_source` chunk but the latest two, and every
  screenshot vision turn but the latest become one-line "superseded — re-fetch
  with X" stubs. Search results, network listings and download outcomes stay
  verbatim (small, durable URLs acted on rounds later).
- **Truncation detection** — `finishReasonOf` + `CONTEXT_EXHAUSTED_MESSAGE` in
  `server/llm/client.ts`; both completion paths now throw "LLM context window
  exceeded …" instead of "LLM returned an empty response" when an empty
  completion has `finish_reason: "length"`. The message deliberately matches
  `isContextOverflowError`, so bot-messaging's window-shrink retry and
  history's batch-shrink retry recover from mid-generation exhaustion too.

Proof: files `server/llm/client.ts`, `server/llm/tool-loop.ts`,
`features/browser-agent/server/agent.ts` (+ tests `agent.test.ts` new,
`tool-loop.test.ts`, `client.test.ts`); lint/typecheck/build clean, unit suite
84 files / 849 tests passed (2026-07-30). Remaining risks: compaction is
always-on (a goal needing two page texts side-by-side must re-read — accepted;
the system prompt already declares old refs stale); a *truncated but non-empty*
final report still ships as-is rather than erroring.

## Voice/vision trace + describe-race overhaul (`done`, 2026-07-27)

Root cause of the "transcription succeeded but the bot said it couldn't hear"
incident (trace `11162be5…` / `69761c50…`): `describeAndStore` handed the
transcript back only through `markDescribed`'s row, which returns null when a
concurrent pass described the row first — the caller then read `description:
null` from the stale pre-read row and told the model transcription failed,
while the trace recorded a clean success. All user decisions 2026-07-27:

- **One reply trace per incoming message.** Live transcribe/describe passes
  record into the `bot-messaging`/`reply` trace (`describeAndStore` takes an
  optional parent `TraceRecorder`; the runtime opens the reply trace before
  eager voice transcription via `startReplyTrace` and the service adopts and
  settles it on every path). Standalone `voice`/`transcribe` and
  `vision`/`describe` traces remain only for backfill/probe passes. Side
  effect (accepted): the `/debug` voice/vision feature filters now show only
  those standalone traces; live passes are inside reply traces. Analytics is
  unaffected — usage events carry explicit `callKind`.
- **Honest describe results.** `describeAndStore` returns the text it produced
  or found: a lost `markDescribed` race re-reads and reuses the winner's text
  (warn event), an already-described row is reused without an LLM call, and a
  parent-trace failure becomes a warn event + null, never a fake success.
- **`message_media` → `chat_messages` FK** on `(chat_id, telegram_message_id)`
  (cascade): media never floats free of the mirror. Migration `0041` sweeps
  orphans first (stub mirror rows for `described` orphans, delete the rest).
  Consequences implemented: media from bot-authored messages is no longer
  ingested (was also wasting transcription calls on other bots' voice), and a
  mirror failure now blocks media handling (warn event on the reply trace).
- **Live-processing semaphore** `chat_messages.processed` (user-proposed): the
  live pipeline mirrors with `false` and releases to `true` in `processUpdate`'s
  `finally`; `listPendingMedia` only returns released rows, with a **10-minute
  timeout** fallback so a crashed pipeline can't hide a row forever. This is
  DB-level, so it also fences a backfill in another process sharing the DB.

Proof: files — `db/schema.ts`, `db/migrations/0041_slimy_molten_man.sql`,
`features/vision/server/{service,repository,backfill}.ts`,
`features/history/server/{service,repository}.ts`,
`features/bot-messaging/server/service.ts`, `server/telegram/process-update.ts`,
`server/trace/{recorder,store,with-trace}.ts` (new `setInputSummary`),
`test/db.ts` (`seedMirrorMessage`), docs (`vision.md`, `voice.md`,
`history.md`). Tests: new coverage for the write-race reuse, parent-trace
nesting, re-delivery reuse, semaphore gating + timeout, pre-opened-trace
settlement; `npm run lint`, `typecheck`, `test`, `test:integration`, `build`
all green (see handoff note below if any flipped). Migration applied to the
dev DB. Remaining risk: the production incident's *second* transcriber was
never identified from the two exported traces alone — if it recurs, check the
trace list for the correlation id and whether another process shares the
production DB.

## Priority 15 — Specialists (`done`, 2026-07-27)

Implemented per the user-decided design of 2026-07-27 (now documented in
`docs/features/specialists.md`): operator-only `/specialists` CRUD, one shared
MCP data toolkit over a unified `specialist_entries` store (free-text
collection + JSONB payload), per-chat activation stacking base + personality +
specialist, in-tool switch gating (self-serve in own DM, owner-only in
groups), the per-specialist `per-chat`/`shared` data-scope flag, proactivity
via the existing scheduled-tasks engine, and three editable seed rows.

Implementation choices within the decided guardrails (values were unspecified):
payload cap 16 384 bytes/entry, query cap 50 results, collection label ≤128
chars, max 32 specialists (the personalities bound). Load-bearing integration
delivered by making scheduled-task fires run with the full registered toolset
(`chatCompletionWithTools`) inside the task chat's tool context — so a
specialist's check-in queries its own entries mid-fire; tool calls are
recorded on the fire trace as `external_call` events.

Proof: files — `db/schema.ts` + migration `0042_next_iron_monger.sql` (three
tables + seeds; **applied to the dev DB**), `features/specialists/*`
(schema/repository/service/mcp-tools/UI), `app/api/specialists/**`,
`app/(dashboard)/specialists/page.tsx`, `lib/features.ts`
(`specialists` + `mcp-tools-specialists`), `lib/realtime.ts` (`specialists`
topic), `server/mcp/runtime.ts`, `components/layout/nav-config.ts`,
`features/bot-messaging/server/{prompt,service}.ts`,
`server/telegram/process-update.ts`,
`features/scheduled-tasks/server/{fire,scheduler}.ts`, docs
(`docs/features/specialists.md`, features README, AGENTS.md). Tests: new
`specialists.integration.test.ts` (18: seeds, CRUD, assignment, switch gating
DM vs group, scope silos, caps, browser, traces), `mcp-tools.test.ts`
(no-active-specialist result, save normalization, switch relaying), prompt
stacking + fire-path composition/tool-context tests added to existing suites.
`npm run lint`, `typecheck`, `test` (716), `test:integration` (311 passed / 31
skipped — the live-LLM-gated ones), `build` all green. Remaining risks: the
dashboard page was verified only by build + tests (operator auth blocks an
agent from logging in — check `/specialists` renders after the next dev-server
restart; the "new MCP tools only appear after a restart" caveat recorded here is
no longer true, see the chat-rules entry — the registry now rebuilds itself when
the tool set changes); gemma4:12b tool-selection quality over the new toolkit is
unmeasured — if the model ignores `specialist_*` tools live, tune the seed
instructions/tool descriptions like the tasks tools were.

## Memory scope placement — `general` holds outsiders again (`done`, 2026-07-28)

*What happened.* Trace `833006d7…`: a user told the bot to remember, once and for
all, who a person discussed in the chat is. The model called `memory_save` with
`scope: "general"`, the tool returned `saved: true`, the bot replied "записав",
and the 17:20 consolidation run reported `general knowledge updated`. The fact was
nowhere afterwards. `GENERAL_MERGE_PROMPT` had been told biography "is a line to
drop" (2026-07-17 rule), so the merge correctly excluded it — and
`runMemoryConsolidation` deletes every note in the batch whenever the merge
returns a non-empty document, kept or not. Confirmed promise, silent loss.

*Decision (operator, 2026-07-28), reversing 2026-07-17.* Placement is decided by
**who the fact is about**: someone this chat knows → `user`; anyone else →
`general` is the right home, name written into the fact. The two follow-ups
offered — "don't delete what the merge didn't keep" and "surface the discard" —
were explicitly declined; the gate is the fix.

*Fixes landed.*
1. **Gate, both directions** (`features/memory/server/service.ts`) —
   `resolveMemorySubject` (chat-scoped reference → known-user id; a reference
   matching nobody now points the model at `general` instead of "drop the fact")
   and `checkGeneralNoteSubject` (a `general` note whose declared `person`
   resolves to a chat participant is refused and sent back as `user`). Both are
   service-level, so the `memory_save` tool and passive extraction clear the same
   bar (extraction already writes through `saveMemoryNote`, and its rejections are
   already traced as warnings).
2. **`mcp-tools.ts` thinned** — the old local `resolveSubjectId` is gone;
   `memory_save`/`memory_get` call the service. Tool description rewritten: which
   scope a person-fact belongs in, and that `person` is meaningful for `general`
   too.
3. **Prompts realigned** — `UNIDENTIFIED_PERSON_RULE` now says "save it as general
   with their name in" (shared by the tool and `EXTRACTION_SYSTEM`);
   `GENERAL_MERGE_PROMPT`'s biography ban replaced with "keep every named fact",
   retaining the never-merge-two-people guard that makes the reversal safe;
   extraction's `general` scope line and empty-roster fallback updated to match.

Files changed: `features/memory/prompt.ts` + `prompt.test.ts`,
`features/memory/extract-prompt.ts` + `extract-prompt.test.ts`,
`features/memory/types.ts`, `features/memory/server/service.ts`,
`features/memory/server/mcp-tools.ts`,
`features/memory/server/memory.integration.test.ts` (new `subject placement`
block), `docs/features/memory.md`, `docs/architecture/data-model.md`,
`docs/architecture/llm-and-mcp.md`.

Verified: `npm test` (75 files, 741 passed), `npm run lint`, `npm run typecheck`,
`npm run build` — all clean. **`npm run test:integration` could not be run** on
this machine: testcontainers finds no container runtime (`docker` is not
installed), so the new `subject placement` tests are unexecuted — run them where
a runtime exists.

*Remaining risks.*
- The gate only sees the subject the model **declares**. A `general` save that
  names no `person` is taken at its word, so a person-fact can still slip in
  unfiled. Content-scanning was considered and rejected: the triggering fact
  ("Muradyan is a friend of \<user A\> who pranked \<user B\>") names two known
  people incidentally while being about a third, so a mention-based guard would
  have rejected exactly the fact this change exists to keep.
- The merge can still fail to carry a note forward for its own reasons, and the
  batch is still deleted either way (declined above). A note lost that way is
  still silent.
- The 2026-07-17 failure mode (name-keyed lines merging across people) is now held
  off by prompt text alone in the merge, plus the gate keeping known people out.
  Watch `/memory` → General knowledge for two outsiders collapsing into one.

## Media downloads — yt-dlp (`done` pending live verification, 2026-07-29)

*What happened.* Trace `11d1809d…`: the owner sent a YouTube Music link and the words
"download track". The run ended with a paragraph identifying the track and the advice
to *"use standard desktop tools like `yt-dlp`"* — no file. Two independent defects:

1. **No capability.** The two download tools take a whole-file URL and an HLS/DASH
   manifest URL. A media site's player has neither: it derives ciphered, per-session,
   per-format stream URLs in its own JavaScript. Reading the page source or the
   network requests finds nothing downloadable, so there was no path to the file.
2. **The goal was watered down before the agent ever saw it.** The user's message was
   "«link» download track". The chat model composed the `browse_web` goal as
   *"…identify the track and find a way to download it **or provide direct info about
   what it is**"* — an alternative the user never offered. The sub-agent took it. Also
   observed, from the model's own reasoning at seq 7: it concluded from prior
   knowledge that YouTube "doesn't have a direct button" and stopped, without calling
   `browser_get_network` or any download tool. Whether that inspection would have
   found anything usable is not established — the ciphered-URL claim above is why the
   new tool exists, not something that run tested.

*Decisions (operator, 2026-07-29).* A **new `browser_download_media` tool** taking the
page URL (not a fallback inside the existing tools); an explicit **`mode: audio |
video`**, always best available audio and best available video with **no quality
ceiling**; **`apk add yt-dlp`** in the Dockerfile with no `YTDLP_PATH` escape hatch;
**no cookies** from the run's browser session in v1.

*Landed.* New pure `features/browser-agent/ytdlp.ts` (argv, progress lines, error
text) + `server/media-download.ts` (spawn, scratch dir inside `DOWNLOADS_DIR` so the
final rename never crosses a filesystem, `YtDlpMissingError` mirroring
`FfmpegMissingError`, SSRF on the page URL). `server/tools.ts`: the new tool, its
dispatch case behind the same owner gate, and `formatBytes`-duplication removed in
favour of a shared `formatTransferLine` in `files.ts` (which also gained
`mimeForFilename`, since yt-dlp hands back a file with no `Content-Type`). Prompt
work for defect 2: the agent system prompt now states that a goal asking for a file is
not done until a download tool was called and forbids ending a run by telling the user
to download it themselves, and `browse_web`'s description forbids adding a weaker
alternative to the user's request. Dockerfile, `docs/features/browser-agent.md`,
getting-started, deployment, troubleshooting, security, overview, llm-and-mcp updated.

*Follow-on: the download size cap became a setting (operator, 2026-07-29).* Asked why
`MAX_DISK_BYTES` (2 GB, files) and `MAX_STREAM_BYTES` (4 GB, streams) both existed. The
two *mechanisms* differ legitimately — the file downloader aborts and deletes the
partial, ffmpeg's `-fs` truncates and keeps a playable one — but nothing in the code,
the commits or the docs justified the two different *values*, and the 4 GB one was
never documented. Adding yt-dlp would have made it a third arbitrary number. Both
constants are gone, replaced by **`settings.browser_download_limit_gb`** (1–100,
default 10), read once per run by the runner and passed into all three downloaders as
`maxBytes` — so those modules keep no settings dependency. yt-dlp's `--max-filesize` is
a third enforcement style again: it refuses *before* downloading, from the declared
size. Migration `0043_fat_shiver_man.sql` (`ADD COLUMN … DEFAULT 10 NOT NULL`) —
**applied to the dev DB**; still to apply wherever else the app runs.

*Verified.* `npm run lint`, `npm run typecheck`, `npm test` and
`npm run test:integration` (319 passed / 32 skipped — the live-LLM-gated ones) all
clean. `npm run build` passed until the bundled Postgres was started with the default
`PG_DATA_DIR=./data/pg`; since then it fails with EACCES on that directory, which is
an environment problem (see troubleshooting: give the data dir group access) and
reproduces identically with every change here stashed; the integration suite ran for the first time this session, the container runtime
the 2026-07-28 entry below lacked now being available. New unit tests:
`ytdlp.test.ts` (16), `server/media-download.test.ts` (10, against a **stub** `yt-dlp`
on `PATH` — real spawn, no network), `server/tools.test.ts` (7, owner gate + mode
default + error surfacing), plus `files.test.ts` additions.

The new setting was also exercised on the running dev instance: both Core fields render,
saving 25 patched only `browser_download_limit_gb` (attach-limit untouched) and survived
a reload, `PATCH /api/settings` returned 422 for 500 and for 0, and the value was
restored to 10. No console errors.

*Live verification (2026-07-29, operator installed yt-dlp 2026.03.17).*
- **Real binary:** `BROWSER_LIVE=1 … primitives-live -t browser_download_media` passed
  in 1.9 s — `Big Buck Bunny.m4a`, 28 237 KB, named from the media's own title, mime
  `audio/mp4`, on-disk size matching.
- **Real agent run, defect 1 closed:** a dashboard run given the incident's own words
  (`«the YouTube Music link» download track`) called `browser_download_media` with
  `mode: "audio"` as its **first and only** tool call — no navigate, no source read, no
  network hunt — and produced `VIRUS (Fytch Remix).opus` (2 866 338 B) in ~5 s, one
  step, status `done`, honest one-line report. The original trace took 5 LLM rounds and
  61 s to deliver no file. gemma4:12b, the same model.

*Unrelated fix found while verifying.* `npm run lint` failed with `EACCES` on
`data/pg`: `eslint.config.mjs`'s `globalIgnores` replaces eslint-config-next's
defaults and never listed `/data`, so the moment anyone follows the documented Compose
default (`PG_DATA_DIR=./data/pg`, root-owned 0700) the whole lint run dies. Added
`data/**` and `downloads/**` — both already in `.gitignore`, neither ever source.

- **Defect 2 closed too.** A subsequent Telegram-originated run composed the goal as
  "Download the audio track from this YouTube Music link: «url»" — the user's request
  intact, no "or …" branch. Both halves of the incident are now fixed in practice.
- **Audio is mp3, not the native container** (operator, 2026-07-29, reversing the
  original choice). That first live run returned `VIRUS (Fytch Remix).opus`, which
  Telegram will not play. Avoiding a lossy-to-lossy re-encode was the wrong thing to
  optimize for when the result is unplayable; `--audio-format mp3 --audio-quality 0`
  now, trading some quality for a file every client handles.

- **Downloads are no longer archived on the server** (operator, 2026-07-29): a file is
  kept locally *only* if it did not reach the chat. `onDownload` now resolves whether
  Telegram actually took the document, and `finishDownload` unlinks on success. The
  record's `inline` flag (was the file small enough to attach?) became
  `deliveredToChat` (did the chat get it?) — the old flag also made a dashboard run's
  downloads read as "attached to chat" when there was no chat at all. Old rows lack the
  field and normalize to `false`, correct for them.

*Remaining risks / next steps.*
- The image still needs rebuilding before the deployment has yt-dlp; only this dev
  machine has it.
- The delete-on-delivery path was verified by unit test and by a dashboard run (which
  always keeps the file, having no chat). **The delivered-and-removed branch has not
  been exercised against real Telegram** — send a small track through the bot and check
  the file is in the chat and gone from `downloads/`.
- ~~The distro yt-dlp is frozen per Alpine release while these sites change often~~ —
  addressed by the yt-dlp updater entry below (2026-08-01).
- No cookies means age-gated, sign-in-walled and region-locked pages fail with
  yt-dlp's own error. That was the accepted v1 scope — revisit if it bites.

## On-disk paths are fixed, not configurable (`done`, 2026-07-29)

Operator decision: drop every path env var and put all local state under `./data`.
Removed — `TRACES_DIR` and `DOWNLOADS_DIR` (app), `PG_DATA_DIR`, `TRACES_DATA_DIR`
and `DOWNLOADS_DATA_DIR` (Compose). The layout is now `data/pg`, `data/traces`,
`data/downloads`, resolved from `process.cwd()`, which is the package root locally
and `/app` in the image — the same literals the Dockerfile creates and Compose
mounts. Every deployment already used the defaults; the only thing the variables
bought was a local/container divergence (`./downloads` vs `/app/data/downloads`) and
longer docs.

New `server/paths.ts` owns `tracesDir()` / `downloadsDir()`. The env vars were
load-bearing for **test isolation**, not for operators, so they are replaced by an
explicit `__setDataDirsForTests()` door in the same module — matching the existing
`__resetTraceStoreForTests` convention. `download.test.ts` and
`media-download.test.ts` no longer need `vi.resetModules()`, since the path is read
per call rather than frozen at import.

Files: `server/paths.ts` (new), `server/env.ts` (schema shrinks to `DATABASE_URL`,
`TZ`, `NODE_ENV`), `server/trace/store.ts`,
`features/browser-agent/server/{download,media-download,stream-download}.ts`,
`test/{setup-trace-store,trace-store}.ts`, both download test files,
`docker-compose.yml`, `.env.example`, `Dockerfile`, and eleven docs.

Verified: `npm run lint`, `typecheck`, `test` (780), `build`, `test:integration`
(319 passed / 32 skipped) all clean.

**Migration note for anyone with an existing checkout:** local downloads move from
`./downloads` to `./data/downloads`. Nothing reads the old path any more, so move its
contents across. A deployment that set any of the five variables to a non-default
path must move that data under `./data` before the next `up`.

## Priority 16 — Chat rules (`done` pending live verification, 2026-07-29)

Standing instructions the bot follows in a chat, set from the chat itself or on
`/rules`, composed into every reply's system prompt and carried out with the
existing toolset. Documented in `docs/features/chat-rules.md`.

*Decisions (operator, 2026-07-29), all three taken as recommended.*
- **Opt-in `always` rules.** A rule is `on-reply` (shapes turns the bot already
  answers) or `always` (may act on a group message nobody addressed). An `always`
  rule costs **one classification call per unaddressed message**, and only in a
  chat that has one — the alternatives considered were on-reply-only (cheapest,
  but the operator's own media-download example would never fire in a group) and
  checking every message unconditionally.
- **Per-chat + global scope.** A rule belongs to one chat, or is global
  (`chat_id is null`) and applies everywhere on top of that chat's own. Global
  rules are dashboard-only to author; a chat sees them and cannot change them.
- **Specialists permission precedent.** From chat: self-serve in a private chat,
  owner-only in a group, enforced in the service, denial returned (not thrown) so
  the model relays it.

*Chosen within the guardrails (values were unspecified):* 32 rules per scope,
1 000-char rule text, duplicate text refused per scope, scope not editable
(delete + recreate), rules block appended **last** in the system prompt.

*Files.* `db/schema.ts` + migration `0044_lean_puck.sql` (**applied to the dev
DB**), `features/chat-rules/*` (schema / format / matcher / repository / service /
mcp-tools / ui), `app/api/chat-rules/**`, `app/(dashboard)/rules/page.tsx`,
`lib/features.ts` (`chat-rules` + `mcp-tools-chat-rules`), `lib/realtime.ts`
(`rules` topic), `components/layout/nav-config.ts`, `server/mcp/runtime.ts`,
`features/analytics/llm-call-kind.ts` (`chat-rule-match`),
`features/bot-messaging/server/{prompt,service,addressing}.ts`,
`server/telegram/process-update.ts`, `server/mcp/context.ts`
(`authorityUserId`), `features/browser-agent/server/mcp-tools.ts`,
`features/scheduled-tasks/server/{fire,scheduler}.ts`, docs (feature page,
features README, `llm-and-mcp.md`, `data-model.md`, AGENTS.md).

*Verified.* `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and
`npm run test:integration` all clean — see the proof line in the handoff below.
New tests: `chat-rules/format.test.ts` (16, incl. `resolveRuleAuthority`),
`matcher.test.ts` (11), `chat-rules/.../mcp-tools.test.ts` (11),
`chat-rules.integration.test.ts` (15), a new
`features/browser-agent/server/mcp-tools.test.ts` (5 — the download gate reads
the turn's authority and provenance stays the sender), plus the standing-rules
block in `features/bot-messaging/server/service.test.ts` and the prompt-order
case in `prompt.test.ts`.

The dashboard was also exercised on the running dev instance: creating a global
`always` rule, pausing and resuming it, switching scope to a DM (where it appears
under "Also in force here — 1 global rule"), and deleting it; all three mutations
showed up on `/debug?feature=chat-rules` with their input summaries, and both new
ids appear in the Debug feature filter. No console errors. The test rule was
deleted again, so the dev DB holds no rules.

*Remaining risks / next steps.*
- **Stale MCP registry — fixed, and it was the first live failure** (trace
  `7a3c354e…`, 2026-07-29). The owner said *"new rule - whenever you see a message
  with link to social network media … download it and send to the chat"* and the
  bot replied *"Understood, I'll make sure to…"* without calling anything. The
  request's tool list in that trace holds 21 tools and no `rules_*`: the running
  dev server's registry was built before `registerChatRulesMcpTools` existed, and
  `loadMcpRegistry` cached it on a `globalThis` symbol that survives hot reload by
  design. `/tools` rendered the same 21 and so looked like a page that had never
  been updated — it is fully automatic, and was showing the truth about a stale
  object. Fixed in `server/mcp/runtime.ts`: the registrars are a table whose
  declared `*_TOOL_NAMES` can be read without building, and a cached registry
  whose tool set differs from the loaded code is discarded and rebuilt (also when
  the cached *instance* predates the class — that happened on the very reload that
  added the check). Verified on the running server: `/tools` went from 21 to 25
  tools, all four `rules_*` present, no restart. Pinned in
  `server/mcp/runtime.test.ts` (4), including the reuse case — a registrar whose
  declared names drift from what it registers would rebuild the MCP server on
  every reply turn.

- **The model would not call `rules_create` even once offered — addressed, still
  unverified** (trace `f33e1ede…`, 2026-07-29). With all four `rules_*` tools in
  the request, the third identical *"new rule - whenever you see a message with
  link to social network media …"* still produced only prose. The reasoning block
  is explicit: it worked out that it *should* call `rules_create`, then argued
  itself out of it across 1 761 completion tokens on two beliefs — *"I already
  confirmed twice"* (its own #962/#964 read as evidence the rule was stored) and
  *"calling `rules_create` again for the exact same text might result in duplicate
  rules"*. It also wrote *"I can't see the internal database"* while holding
  `rules_list`. Note the transcript is now self-poisoning: three empty
  confirmations sit in the 24-hour window.

  Fixes (prompt/tool side, per the standing "we never solve model problems by
  code" rule — the one code change makes the tool safe to repeat rather than
  gating anything): chat-side create is **idempotent** (`RuleWriteResult.exists`
  → plain success, stored rule untouched; the dashboard still 409s), the text is
  normalized in the service so an untrimmed repeat cannot slip past the duplicate
  check, `RULES_CREATE_DESCRIPTION` now states that its own agreement is not a
  saved rule, that a repeat is safe, that a repeated instruction means it was not
  believed, and that `rules_list` is the only evidence — and the general form went
  into `BASE_SYSTEM_PROMPT`'s Honesty block (a past confirmation is not evidence of
  having acted; a repeated request is a request; never skip a call for fear of
  doing it twice), which also covers the `tasks_list` fabrication tracked below.

  **Verified against the real model**, unlike the earlier rounds of this
  tool-avoidance family: new
  `features/chat-rules/server/tool-selection.integration.test.ts` drives live
  gemma4:12b through the production prompt + real tool schemas (6 cases — rule
  saved, `always` trigger chosen for "whenever you see a message …", `rules_list`
  on "what rules do you have", list→delete on "forget the rule", and a plain
  "from now on answer in one sentence" going to `rules_create` rather than
  `memory_save`/`tasks_create`). The load-bearing case replays the incident's
  **poisoned transcript** — the bot's own two empty confirmations as `priorTurns`
  — and the model now calls `rules_create` anyway. 3 consecutive full runs, 18/18.
  Canned `rules_*` results added to `test/tool-selection.ts`.

  **The end-to-end path is verified too** (2026-07-29, after the operator fixed the
  `data/pg` permissions): new
  `features/chat-rules/server/live-flow.integration.test.ts` drives synthetic
  updates through the whole real `processUpdate` pipeline against live gemma4:12b,
  in two fresh synthetic chats it cleans up afterwards. Three cases, 3 consecutive
  runs, 9/9:
  - a group holding one dashboard-authored `always` rule, where a **non-owner**
    member posts a TikTok link **without addressing the bot** → the turn opens, and
    the enqueued `browser_agent_runs` row has `is_owner = true` (the rule author's
    rights) with `created_by_user_id` still the poster (provenance untouched) and
    the link in the goal;
  - a synthetic user's DM, where "new rule: from now on always answer me in one
    short sentence" is stored through a real `rules_create` call (`source: chat`),
    traced under `mcp-tools-chat-rules`;
  - ordinary chatter in that same rule-bearing group → still silent
    (`ignored / not_addressed`), so the matcher is not a "reply to everything" switch.

  No owner-sent turn in that test **on purpose**: the owner is a real person in the
  real database and `rememberUser` would overwrite their stored profile with
  synthetic names. The chat-side create is covered in the DM instead, and the
  authority half only needs the matched rule to be dashboard-authored.

  A real Telegram round trip is still the one thing untested by machine — the
  delivered file in a real chat. Everything up to `browse_web` being called with
  owner rights is now proven.

- **The bot side is still not verified live** — the first attempt never reached
  the feature at all, the second never called the tool. The run that matters: in a group, have the owner say *"new rule: when someone posts
  a video link, download it and send it here"*, confirm `rules_create` was called
  (not just claimed — this is exactly the gemma4:12b bluffing pattern tracked in
  the two items below), then have someone post a link **without** addressing the
  bot and check the `chat rule match` step on that message's reply trace.
- **A rule carries its author's rights** (operator decision, 2026-07-29 — *"rule
  creator beats message source"*, reversing the first cut, where the owner-gated
  download made the example rule owner-only in practice). `resolveRuleAuthority`
  elevates a turn to the owner when a **matched** rule was written by the owner or
  in the dashboard; the runtime binds it as `authorityUserId` on the MCP tool
  context and `browse_web` reads it for the download gate. Permissions only —
  `userId` is untouched, so memory/task/run provenance stays the real sender — and
  a rule an ordinary user wrote in their own DM elevates nothing.

  Consequence, and the reason the matcher now runs on **addressed** turns too:
  the answer has to be the same whether or not the person named the bot, so a
  chat with an owner-authored rule pays one classification per addressed message
  from a non-owner as well. It is skipped when it could change nothing (sender is
  the owner, or no rule an elevated author wrote). An `on-reply` rule can lend
  rights even though it can never open a turn.

  Residual risk: a non-owner can put text in front of an elevated turn. They
  cannot *request* an elevated action — only say something a rule matches, with
  the model then told to do what that rule requires and nothing else — but a 12B
  model steered by a crafted message is the exposure the owner accepted here.
  Worth re-reading the `browse_web` goal on the first live rule-driven downloads.
- **The matcher reads text only.** A rule triggered by a bare photo or sticker
  cannot match an unaddressed message; it still works as `on-reply`.
- **Cost on a busy group** is one extra call per unaddressed message once any
  `always` rule exists. Watch Model performance → `chat-rule-match` after the
  first such rule is set; if it is heavy, the lever is making the rule
  `on-reply`.

## Reply latency: LLM priority gate, thinking caps, parallel classifications (`done` pending production deploy + live verification, 2026-08-01)

Measured on the live bot (Debug traces, 2026-08-01): a successful reply took
27–70 s, an ignored group message 5–9 s, and the background jobs were dying —
`history-summaries` and `memory-extraction` failed with "Connection … timed
out" after exactly 120 s because every feature's requests pile into the single
LLM endpoint's queue and the wire timeout burns while queued. Breakdown of a
69 s reply: addressing analyzer 14 s (~1,000 completion tokens — the configured
model thinks, and the thinking dwarfed its 56-char JSON verdict), verifier
4.5 s, final answer 50.7 s (~23k prompt tokens).

*Decisions (operator, 2026-08-01).*

- **Replies have the highest priority** on the shared endpoint; background jobs
  wait. No separate worker/service — an in-process gate on the established
  `globalThis`-singleton pattern.
- **Same model for the classification calls** (no small-model routing);
  **thinking capped** instead (`reasoning_effort: "low"` + a hard
  1,000-token stop).
- **Reply completion capped** (4,096-token hard stop + a stronger brevity rule
  in the base prompt); the ~23k-token reply prompt is **not** shrunk — history
  stays as is, but the summaries job had to be fixed (see priority gate).
- Addressing analyzer and chat-rule matcher **run concurrently** (they judge
  the same message independently). On the rare turn the analyzer opens itself,
  the already-started unaddressed rule match is settled first and the
  addressed-turn pass still has the last word on authority.

*How the gate works* (`server/llm/priority.ts`): interactive calls (replies,
addressing/rule classifications, live vision describes, scheduled-task fires,
browser-agent rounds) dispatch immediately; background calls (history
summaries, memory extraction/consolidation, vision backfill, analytics
insights, self-improvement) wait until no interactive call is in flight and at
most one background call is on the wire. A background call's HTTP timeout now
starts at dispatch, not enqueue — that alone removes the 120 s starvation
deaths — and background calls default to a 300 s wire timeout
(`BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS`) since a summarize batch legitimately
outlives 120 s on a local model. No preemption: an interactive call arriving
mid-background-request queues behind that one request on the provider.

*Files.* New — `server/llm/priority.ts` (+ `priority.test.ts`). Changed —
`server/llm/client.ts` (`priority`/`maxTokens`/`reasoningEffort` inputs, gate
wrap, background timeout), `server/llm/tool-loop.ts` (per-round gate +
`maxTokens`), `server/telegram/process-update.ts` (classifier + reply caps),
`features/bot-messaging/server/service.ts` (concurrent analyzer/rule match; +
2 tests in `service.test.ts`), `features/bot-messaging/server/prompt.ts`
(brevity rules), `features/vision/server/service.ts` +
`backfill-scheduler.ts` (describe priority by caller), and the background
schedulers of history/memory/analytics/self-improvement (priority tag).

*Verification.* `npm run lint` ✅, `npm run typecheck` ✅, unit tests ✅ (158
in the touched files; full suite 920 passed with 21 pre-existing yt-dlp
failures on Windows, also failing on a clean checkout — environment, not
regression), `npm run build` ✅. Integration suite not run (Testcontainers).

*Endpoint probe (2026-08-01, against the configured Ollama 0.32.5, synthetic
classifier-shaped calls on gemma4:12b).* `reasoning_effort: "low"` is accepted
(no error) but only mildly shrinks this model's thinking (~3.6k → ~2.9k chars
in one pair, ~8.2k → ~3.7k in another); `max_tokens` is honored; 4 concurrent
calls really do run concurrently (wall ≈ slowest call, not the sum), so
`OLLAMA_NUM_PARALLEL=4` works. The original 1,000-token classifier cap
truncated 3 of 8 probe calls mid-think (`finish_reason: "length"`, empty
content = a missed summons) — raised to 3,000 the same day, sized above every
observed think-then-answer (max seen: 2,229 tokens).

Probe also showed per-request decode collapsed to ~10–15 tok/s (from ~70 tok/s
in the pre-parallel production traces): with 4 slots' KV cache reserved, only
9.7 GB of the 12.2 GB model stays in VRAM (`/api/ps`), the rest on CPU — see
the operator note below about `OLLAMA_NUM_PARALLEL`/context sizing.

*Remaining risks / live verification checklist (after deploy).*

- Classifier cap 3,000: confirm addressing-check traces parse and completion
  tokens stay well under the cap; if `finish_reason: "length"` shows up on a
  classification, raise further or drop the cap.
- A reply cut off at 4,096 generated tokens surfaces as a failed turn
  (`finish_reason: "length"`); none observed near that size, but check error
  traces in the first days.
- `history-summaries` / `memory-extraction`: confirm the nightly runs complete
  instead of timing out; a single batch still over 300 s on the wire will
  still fail and should prompt revisiting batch size.
- Constant interactive traffic starves background jobs by design; if backlogs
  grow (summaries days behind), consider a fairness valve.

## Other open items

- **Local Telegram Bot API server (`todo`; operator-requested, 2026-08-01)** —
  the standard Bot API caps bot uploads at 50 MB, which is what forces the
  attach-or-fail path for most videos. Running the official
  `telegram-bot-api` server locally raises the ceiling to 2 GB, so nearly every
  browser-agent download could actually reach the chat. Scope when picked up: a
  new Compose service, grammY pointed at the local endpoint (`apiRoot`), token
  logout/login migration between cloud and local API, and a decision on where
  its file store lives. New infrastructure — present the design per the
  Decision Notes process before building.

- **Ukrainian idiomatic joke requests never trigger tools on gemma4:12b
  (`blocked` on a model decision;** from the 2026-07-27 "lied about scheduling"
  trace `64067530…`**)** — a persona-mode, third-person recurring gag request
  in idiomatic Ukrainian ("let \<persona\> send everyone ... once a day",
  phrased colloquially) made the model claim it had scheduled the task without
  calling `tasks_create`. Fixes landed: the base prompt's Honesty rules now
  bind action claims to tool calls (in character too), the Conversation rules
  treat third-person requests about the bot as requests to it, and the
  `tasks_create` description covers joke/third-person recurring phrasings —
  verified live: the model no longer fabricates the action, and both the
  identical English joke phrasing and a plain Ukrainian daily-reminder request
  now select `tasks_create`. But the idiomatic-Ukrainian variant failed 5/5
  live runs — a cross-lingual gap in gemma4:12b itself. The English variant is
  pinned in `features/scheduled-tasks/server/tool-selection.integration.test.ts`;
  the Ukrainian one is deliberately NOT pinned in code (no Cyrillic in code —
  user rule, 2026-07-27) and lives only in the exported trace. Next decision
  needed (operator): try a stronger/tool-tuned model in Settings for the reply
  path, or accept the gap; re-verify against the trace phrasing after any
  model change. Related observation feeding the same decision: the plain
  English "what reminders do I have?" live case intermittently fabricates a
  full reminder list without calling `tasks_list` (seen 2 of ~6 live suite
  runs, 2026-07-27) — same bluffing pattern, worth including when evaluating a
  replacement model.

- **Context-free reminders + bluffing instead of searching history
  (`in-progress`;** from the 2026-07-28 traces `257ad4e9…` and `925ecf31…`, plus
  the operator's account of how the task was set up**)** — one incident, two
  defects, at opposite ends of the same feature.

  *What happened.* A person was discussed in the chat over several days. A user
  asked the bot to remind another participant daily who that person is. The bot
  created a scheduled task whose instruction was the surface phrasing of the
  request ("remind X who \<person\> is") rather than the substance, so every fire
  delivered that sentence back — a reminder that points at a fact instead of
  carrying it. When the reminded user then asked outright who the person was, the
  bot never called a history tool across five consecutive turns
  (`finish_reason: stop`, zero tool calls, all 21 tools offered), accused them of
  faking amnesia, and answered with an empty metaphor. Its own reasoning trace
  states it cannot find the term, then improvises anyway.

  *Root cause of the reminder half.* `fireScheduledTask` composes base prompt +
  persona + specialist + language + directive and **loads no transcript at all**
  (`features/scheduled-tasks/server/fire.ts`), so the firing model has no way to
  know what the instruction refers to. `tasks_create` only ever asked for a
  "self-contained" instruction without saying that self-contained means carrying
  the facts.

  *Fixes landed* (design decision — operator, 2026-07-28: fix at **both** ends
  rather than either alone, since a 12B model may miss either step):
  1. **Grounding** block in `BASE_SYSTEM_PROMPT`
     (`features/bot-messaging/server/prompt.ts`) — factual claims limited to
     transcript / durable memory / this-turn tool results; searching history is
     mandatory for an unfindable reference; "I don't know" is an acceptable
     answer; covering a gap by accusing the asker is forbidden; the persona
     governs tone and never truth.
  2. **`TASKS_CREATE_DESCRIPTION`** (extracted to an exported constant so it can
     be pinned) — states that a fire sees only the instruction text, requires
     `history_search` → `history_get_in_range` before creating a task that
     references chat-specific people/events/topics, requires the findings be
     written into the instruction, and says to ask the user rather than store an
     empty pointer. Same rule echoed on the `instruction` field of
     `tasks_create`/`tasks_update`.
  3. **`buildTaskDirectiveMessage`** (`fire.ts`) — second line of defence: tells
     the fire it has no transcript, to look the reference up in history before
     writing, and to be honest rather than parrot the directive when the lookup
     comes up empty. The fire already runs with the full toolset bound to the
     task's chat, so the lookup is available.

  Files changed: `features/bot-messaging/server/prompt.ts` + `prompt.test.ts`,
  `features/scheduled-tasks/server/mcp-tools.ts` + `mcp-tools.test.ts`,
  `features/scheduled-tasks/server/fire.ts` + `fire.test.ts`. Verified:
  `npm test` (74 files, 727 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Live re-test of the reply half: failed* (trace `f79f84a2…`, 2026-07-28). Asked
  "хто такий Мурадян?" the bot again called no tool and again answered with a
  metaphor. Its reasoning block names the source explicitly: *"looking at my
  previous response (#13164), I defined it as a symbol of bypassing direct routes"*,
  padded with general knowledge (*"in common underground/internet/tech contexts
  (especially in Ukraine), 'Muradyan' often refers to…"*). The term occurs five
  times in the 24-hour window: twice asserted by the bot, three times as
  participants asking what it means. **No human ever said what it is** — the bot
  invented it, then read its own invention back as established fact.

  *Root cause of the miss.* Grounding declared "the transcript" a source
  wholesale, and a bot line is transcript. The rule's own bot-specific clause
  ("if you cannot back it up, say so") reads as being about *honesty under
  challenge*, not about *what counts as evidence*, so a self-confirming loop
  passed it.

  *Second round of fixes* (design decision — operator, 2026-07-28: **rank the
  sources**, prioritize user-sourced information over bot-sourced; enforcement
  stays in the prompt — *"we never solve model problems by code"* — so no gating,
  forced retrieval, or verifier pass):
  4. **Grounding** rewritten around source rank: fact = what a *person here*
     said, durable memory, or a this-turn tool result. The bot's own messages are
     "never a source" and are declared unreliable outright — wrong, stale,
     polluted by the conversation, or invented. People outrank the bot; a user
     correction is taken as correct. A term appearing *only* in the bot's own
     lines is named as the not-known case, with re-deriving a meaning from its
     own earlier wording forbidden. Mirrors what memory extraction already does
     (`EXTRACTION_SYSTEM` refuses to harvest facts from bot lines).
  5. **`TRANSCRIPT_PREAMBLE`** (`features/history/server/format.ts`) — says it at
     the point of use: the other people's lines are what was said, the bot's own
     are not evidence and may be wrong or invented.
  6. **History tool results carry provenance**
     (`features/history/server/mcp-tools.ts`) — each line names its author in
     words (`a participant` / `you (the bot)`) instead of the wire role, and a
     result whose every row is bot-authored appends
     `SELF_AUTHORED_ONLY_NOTE` ("…this result confirms nothing… Treat this as not
     found."). The only code-side change, and only because the prompt's source
     ranking is unusable if a lookup hands back rows without saying whose they
     are. `structuredContent.role` is unchanged for machine consumers.

  Files changed (round 2): `features/bot-messaging/server/prompt.ts` +
  `prompt.test.ts`, `features/history/server/format.ts` + `format.test.ts`,
  `features/history/server/mcp-tools.ts` + new `mcp-tools.test.ts`. Verified:
  `npm test` (75 files, 739 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Third round: dedicated `context` field* (rework — user direction, 2026-07-31:
  instead of one-liner instructions the bot has to **gather and save context**
  when creating a task; asking for the facts to be woven into the instruction
  text, round 1's approach, still produced one-liners in practice):
  7. **`scheduled_tasks.context` column** (nullable text; migration
     `db/migrations/0045_first_metal_master.sql`) threaded through the row
     mapper, repository insert/update, service create/update (trim + 4000-char
     bound, blank stores null), and `ScheduledTask`.
  8. **Tool contract**: `tasks_create` gains a **required** `context` input —
     the gathered background, written self-contained for a reader with no chat
     transcript; `''` allowed only for a fully self-contained instruction.
     `TASKS_CREATE_DESCRIPTION` reworked around "GATHER CONTEXT BEFORE
     CREATING" (from the visible conversation or `history_search` /
     `history_get_in_range`), keeping the ask-instead-of-storing-a-pointer and
     third-person/gag rules. `tasks_update` gains an optional `context`
     replacement; `tasks_get`/`tasks_list` structured views include it.
  9. **Fire prompt** (`buildTaskDirectiveMessage`) — a "Saved context" block
     carries the stored background into the fire; the history lookup stays as
     fallback for tasks that predate the field.
  10. **Dashboard** — optional Context textarea on create and edit
     (`ScheduledTasksManager`), context shown on task cards; dashboard API
     create/patch accept it (`context: null` clears on patch).

  Files changed (round 3): `db/schema.ts` + migration 0045,
  `features/scheduled-tasks/{types.ts, server/repository.ts, server/schema.ts,
  server/service.ts, server/mcp-tools.ts, server/fire.ts,
  ui/ScheduledTasksManager.tsx}`, `app/api/scheduled-tasks/route.ts`, tests
  (`fire.test.ts`, `mcp-tools.test.ts`, `scheduled-tasks.integration.test.ts`).
  Verified: `npm run lint`, `npm run typecheck` clean; `npm test` 84 files /
  852 passed; `npm run test:integration` 25 files / 338 passed (11 live files
  skipped); `npm run build` green after the operator re-ran the `data/pg`
  chmod (the recurrence is tracked below).

  *New evidence for the model half* (trace `e5f96e23…`, 2026-07-31): asked (in
  Ukrainian) to *update* the Muradyan task with the PS5/donations backstory,
  gemma4:12b's reasoning correctly narrowed to the scheduled task and literally
  ended "Let's do that check" (meaning `tasks_list`) — then the generation
  emitted a plain chat message claiming the context was saved
  (`finish_reason: stop`, `tool_calls: null`, all 25 tools offered). The
  decision died crossing from the reasoning channel to generation; no prompt
  text can bind that. Two levers, both operator decisions: (a) the standing
  model-replacement question below; (b) injecting the chat's scheduled tasks
  into the reply-turn system context (like memory/rules) so "the task" resolves
  without a `tasks_list` round-trip — costs tokens per turn, not implemented.

  **Remaining risk / next step (operator):** still unverified live, and still the
  same gemma4:12b tool-avoidance pattern as the `tasks_list` fabrication in the
  item above — round 1's prompt text was ignored, and rounds 2–3 add more prompt
  text plus a required tool field, so the model may ignore them too. Re-run
  live: ask the bot who "Мурадян" is again; a pass is "I don't know / nobody
  here ever said". Also re-run the task half (create a reminder that references
  a chat-only topic — a pass now includes a filled `context` on the created
  row; then ask the bot what that topic is). Existing thin task instructions
  are deliberately **not** migrated — operator fixes those through the bot
  (decision, 2026-07-28); old rows simply have `context = null` and keep the
  history-lookup fallback. If the model still refuses to search, this folds
  into the same model-replacement decision. Known remaining laundering path,
  not addressed: `history_recall_topics`
  serves daily topic summaries, which are written over both sides of the
  conversation — a bot-invented term can therefore re-enter through a summary
  with no author attached. Decide whether summaries should mark, or exclude,
  bot-sourced content.

- **`npm run build` dies on `data/pg` whenever the bundled Postgres recreates it
  (`done` for now — one host-side fix, may recur).** Turbopack walks the project
  tree and `data/pg` is created `drwx------` owned by the container's postgres uid,
  so the build ends in `Permission denied (os error 13) … reading dir "…/data/pg"`
  with a `TurbopackInternalError` — nothing to do with the code (`eslint.config.mjs`
  already ignores `data/**` for the same reason; Turbopack has no equivalent).
  The operator ran the chmod on 2026-07-29 and the build was green again. It
  **recurred** on 2026-07-31 (a fresh Postgres volume recreated the dir); the
  operator re-ran the chmod the same day. **Recurred again on 2026-08-01**,
  blocking the build check for the chat-delivery overhaul above, and **still
  failing later the same day** for the poller-supervision work. Four recurrences
  now — worth a documented pre-build step (or a Turbopack-side exclusion if one
  appears).

- **Traces bind-mount permissions (`blocked` on an operator decision;** from
  the 2026-07-22 prod data-loss incident**)** — Docker auto-creates
  `./data/traces` root-owned while the app runs as the non-root `app` user, so
  trace flushes fail with EACCES (now surfaced via the data-loss banner, the
  Overview card and `/api/health`). Host-side workaround: chown the bind mount
  to the container's `app` uid. The permanent Dockerfile fix (root entrypoint
  chowns the mount, then drops to `app` via su-exec) was proposed but not
  implemented — a container security-posture change that needs the operator's
  decision.
- **Search-engine cascade (operator's call)** — engines rank themselves by
  success stats, so the blocked-engines-first configured order self-heals; the
  open question is adding **Brave** as a fourth engine (measured best on
  2026-07-26: 45 relevant results).
- **Memory General-knowledge cleanup (verify)** — the wrong pre-fix lines in
  the General knowledge document (2026-07-17 incident) needed manual removal on
  `/memory`; the pruning merge only runs when a new `general` note arrives.
  Verify the cleanup happened; drop this item if it did.
